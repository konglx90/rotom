import { type Router as ExpressRouter } from "express";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { MeshDb } from "../db.js";
import { resolveGroupArtifactRoot } from "../group-paths.js";
import { resolveGroupWorktreeInfo } from "../repo-scan.js";
import { toBeijing } from "../../shared/time.js";

/** Walk up from `startPath` looking for a `.git` directory. Returns the repo
 *  root or null if we hit the filesystem root without finding one. Shared
 *  by /original, /diff and /refs so they don't each re-implement the walk.
 *
 *  `startPath` can be either a file or directory path: we check it first
 *  (in case the caller already points at the repo root) before walking up. */
function findGitRoot(startPath: string): string | null {
  let cursor = fs.existsSync(startPath) && fs.statSync(startPath).isFile()
    ? path.dirname(startPath)
    : startPath;
  const stopAt = path.parse(cursor).root;
  while (cursor && cursor !== stopAt) {
    if (fs.existsSync(path.join(cursor, ".git"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

interface FileEntry {
  name: string;
  path: string;
  absPath: string;
  size: number;
  modifiedTime: string;
  type: "file" | "directory";
  children?: FileEntry[];
}

function walkDir(dir: string, base: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const item of items) {
    if (item.name.startsWith(".")) continue;
    if (item.name === "node_modules") continue;
    const fullPath = path.join(dir, item.name);
    const relPath = path.relative(base, fullPath);
    // 用 statSync(跟随 symlink)判断真实类型,让 extraRepo 的 mountPath symlink
    // 能被当作目录 walk。Dirent.isDirectory() 对 symlink 返回 false(lstat),
    // 会漏掉 symlink 指向目录的条目。
    let stat: fs.Stats;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      entries.push({
        name: item.name,
        path: relPath,
        absPath: fullPath,
        size: 0,
        modifiedTime: toBeijing(stat.mtime),
        type: "directory",
        children: walkDir(fullPath, base),
      });
    } else if (stat.isFile()) {
      entries.push({
        name: item.name,
        path: relPath,
        absPath: fullPath,
        size: stat.size,
        modifiedTime: toBeijing(stat.mtime),
        type: "file",
      });
    }
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/** 递归给 FileEntry 的 path 加前缀(如 `__repos/`),让注入的虚拟节点的 children
 *  的 path 带上前缀,前端点击时 content API 能识别并切换 base。 */
function addPathPrefix(entries: FileEntry[], prefix: string): FileEntry[] {
  return entries.map(e => ({
    ...e,
    path: prefix + e.path,
    children: e.children ? addPathPrefix(e.children, prefix) : undefined,
  }));
}

export function registerArtifactRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  apiRouter.get("/artifacts/:groupId", (req, res) => {
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    if (!fs.existsSync(groupDir)) {
      res.json([]);
      return;
    }

    let files = walkDir(groupDir, groupDir);
    // 配了 repo 的群:注入 `__repos` 虚拟节点(指向 primary worktree),
    // 让 Dashboard 能浏览 worktree 代码 + group 产物。worktree 在
    // ~/.rotom/repos/<repoName>-<id8>-wt/group-<groupId8>/,不在 groupDir 下。
    // 用 `__repos` 避免和仓库里真实的 repos/ 目录冲突,`__` 前缀标记虚拟节点。
    const wtInfo = resolveGroupWorktreeInfo(db, req.params.groupId);
    if (wtInfo && wtInfo.primaryExists) {
      try {
        const wtFiles = walkDir(wtInfo.primaryPath, wtInfo.primaryPath);
        // 给所有 path 加 `__repos/` 前缀,让 content/original/diff API 能识别
        // (path 以 `__repos/` 开头时 base 换成 worktree)
        const prefixed = addPathPrefix(wtFiles, "__repos/");
        const filtered = files.filter(f => f.name !== "__repos");
        filtered.push({
          name: "__repos",
          path: "__repos",
          absPath: wtInfo.primaryPath,
          size: 0,
          modifiedTime: toBeijing(fs.statSync(wtInfo.primaryPath).mtime),
          type: "directory" as const,
          children: prefixed,
        });
        filtered.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        files = filtered;
      } catch {
        // worktree 读取失败,保留原 files
      }
    }

    res.json({
      root: groupDir,
      files,
    });
  });

  apiRouter.get("/artifacts/:groupId/content", (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    // `__repos/...` 是虚拟注入节点(指向 primary worktree),不在 groupDir 下。
    // 真实路径在 worktree 里,这里把 base 换成 worktree 路径,并剥掉 `__repos/` 前缀。
    const wtInfo = resolveGroupWorktreeInfo(db, req.params.groupId);
    let baseDir = groupDir;
    let relPath = filePath;
    if (wtInfo && wtInfo.primaryExists && filePath.startsWith("__repos/")) {
      baseDir = wtInfo.primaryPath;
      relPath = filePath.slice("__repos/".length);
    }
    const resolved = path.resolve(baseDir, relPath);
    // 安全检查:resolved 必须在 baseDir 下(或就是 baseDir)
    if (!resolved.startsWith(path.resolve(baseDir))) {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const stat = fs.statSync(resolved);
    const MAX_SIZE = 500 * 1024;
    if (stat.size > MAX_SIZE) {
      res.json({ path: filePath, content: `[File too large: ${(stat.size / 1024).toFixed(1)}KB]`, size: stat.size, type: "text" as const });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const binaryExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip"]);
    if (binaryExts.has(ext)) {
      const buf = fs.readFileSync(resolved);
      res.json({ path: filePath, content: buf.toString("base64"), size: stat.size, type: "binary" as const });
    } else {
      const content = fs.readFileSync(resolved, "utf-8");
      res.json({ path: filePath, content, size: stat.size, type: "text" as const });
    }
  });

  apiRouter.get("/artifacts/:groupId/original", (req, res) => {
    const filePath = req.query.path as string;
    const base = (req.query.base as string) || "HEAD";
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(base)) {
      res.status(400).json({ error: "Invalid base ref" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    const resolved = path.resolve(groupDir, filePath);
    if (!resolved.startsWith(path.resolve(groupDir))) {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    const repoRoot = findGitRoot(resolved);
    if (!repoRoot) {
      res.json({ path: filePath, base, repoRoot: null, content: "", note: "目标文件不在 git 仓库中。" });
      return;
    }
    const relInRepo = path.relative(repoRoot, resolved);
    const result = spawnSync("git", ["show", `${base}:${relInRepo}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error) {
      res.status(500).json({ error: `git show failed: ${result.error.message}` });
      return;
    }
    if (result.status !== 0) {
      res.json({
        path: filePath,
        base,
        repoRoot,
        relInRepo,
        content: "",
        note: result.stderr?.trim() || `file not present at ${base}`,
      });
      return;
    }
    res.json({
      path: filePath,
      base,
      repoRoot,
      relInRepo,
      content: result.stdout,
    });
  });

  apiRouter.get("/artifacts/:groupId/diff", (req, res) => {
    const filePath = req.query.path as string;
    const base = (req.query.base as string) || "HEAD";
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(base)) {
      res.status(400).json({ error: "Invalid base ref" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    const resolved = path.resolve(groupDir, filePath);
    if (!resolved.startsWith(path.resolve(groupDir))) {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const repoRoot = findGitRoot(resolved);
    if (!repoRoot) {
      res.json({ path: filePath, base, repoRoot: null, diff: "", note: "目标文件不在 git 仓库中，无法计算 diff。" });
      return;
    }
    const relInRepo = path.relative(repoRoot, resolved);
    const result = spawnSync("git", ["diff", "--no-color", base, "--", relInRepo], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error) {
      res.status(500).json({ error: `git diff failed: ${result.error.message}` });
      return;
    }
    if (result.status !== 0 && result.status !== null) {
      res.status(500).json({
        error: `git diff exited ${result.status}`,
        stderr: result.stderr,
      });
      return;
    }
    res.json({
      path: filePath,
      base,
      repoRoot,
      relInRepo,
      diff: result.stdout,
    });
  });

  // List git refs (branches + tags) for the group's artifact root, used by the
  // dashboard to populate the diff-base dropdown. Walks up from the group dir
  // to find the nearest .git; returns empty lists (with a note) when not in a
  // repo. The HEAD branch name is included so the UI can mark it as default.
  apiRouter.get("/artifacts/:groupId/refs", (req, res) => {
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    if (!fs.existsSync(groupDir)) {
      res.json({ refs: [], heads: [], tags: [], head: "", note: "群产物目录不存在。" });
      return;
    }
    const repoRoot = findGitRoot(groupDir);
    if (!repoRoot) {
      res.json({ refs: [], heads: [], tags: [], head: "", note: "目标目录不在 git 仓库中。" });
      return;
    }
    const listResult = spawnSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/", "refs/tags/"],
      { cwd: repoRoot, encoding: "utf-8", maxBuffer: 1024 * 1024, timeout: 5000 },
    );
    if (listResult.error) {
      res.status(500).json({ error: `git for-each-ref failed: ${listResult.error.message}` });
      return;
    }
    if (listResult.status !== 0 && listResult.status !== null) {
      res.status(500).json({
        error: `git for-each-ref exited ${listResult.status}`,
        stderr: listResult.stderr,
      });
      return;
    }
    const all = listResult.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const headResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 3000,
    });
    const head = headResult.stdout?.trim() || "";
    res.json({
      refs: all,
      heads: all.filter((r) => !r.startsWith("tags/")),
      tags: all.filter((r) => r.startsWith("tags/")).map((r) => r.replace(/^tags\//, "")),
      head,
      repoRoot,
    });
  });
}
