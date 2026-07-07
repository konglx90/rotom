import { type Router as ExpressRouter } from "express";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { MeshDb } from "../db.js";
import { resolveGroupArtifactRoot } from "../group-paths.js";
import { resolveGroupWorktreeInfo } from "../repo-scan.js";
import { readFileSafely, walkDir, type FileEntry } from "../util/fs.js";
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

/** branch-diff / content-at-ref / refs 通用:把 `repo` query 参数
 *  (默认 "primary")解析成对应 worktree 的物理路径。primary 走
 *  resolveGroupWorktreeInfo().primaryPath,extras 按 id 匹配。
 *  成功返回 worktree 信息;失败返回错误响应(调用方负责写 res)。 */
function resolveRepoWorktree(
  db: MeshDb,
  groupId: string,
  repo: string | undefined,
):
  | { repo: string; worktreePath: string; exists: boolean; url: string; branch: string | null; mountPath?: string }
  | { error: string; status: number } {
  const wtInfo = resolveGroupWorktreeInfo(db, groupId);
  if (!wtInfo) {
    return { error: "该群未配置仓库(repo_url 为空)。", status: 400 };
  }
  const repoId = repo && repo.trim() ? repo.trim() : "primary";
  if (repoId === "primary") {
    if (!wtInfo.primaryExists) {
      return { error: "primary worktree 未创建(executor 尚未拉取该群代码)。", status: 400 };
    }
    return {
      repo: "primary",
      worktreePath: wtInfo.primaryPath,
      exists: wtInfo.primaryExists,
      url: wtInfo.url,
      branch: wtInfo.branch,
    };
  }
  const extra = wtInfo.extras.find((e) => e.id === repoId);
  if (!extra) {
    return { error: `未找到 repo: ${repoId}`, status: 400 };
  }
  if (!extra.exists) {
    return { error: `extra worktree 未创建: ${extra.id}`, status: 400 };
  }
  return {
    repo: extra.id,
    worktreePath: extra.path,
    exists: extra.exists,
    url: extra.url,
    branch: extra.branch,
    mountPath: extra.mountPath,
  };
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
    const result = readFileSafely(baseDir, relPath);
    if (result.kind === "outside-base") {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    if (result.kind === "missing") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (result.kind === "too-large") {
      res.json({
        path: filePath,
        content: `[File too large: ${(result.size / 1024).toFixed(1)}KB]`,
        size: result.size,
        type: "text" as const,
      });
      return;
    }
    res.json({
      path: filePath,
      content: result.content,
      size: result.size,
      type: result.type,
    });
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
  //
  // `?repo=<id>`(可选):传了就切到对应 worktree(primary 或 extras 之一)
  // 列 refs,供「分支对比」模式按仓库分别取 refs。不传时维持旧行为(从
  // groupDir 起找 .git),保持向后兼容。
  apiRouter.get("/artifacts/:groupId/refs", (req, res) => {
    const repoParam = req.query.repo as string | undefined;
    let repoRoot: string | null;
    let repoLabel = "primary";
    if (repoParam && repoParam.trim()) {
      const resolved = resolveRepoWorktree(db, req.params.groupId, repoParam);
      if ("error" in resolved) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }
      repoRoot = findGitRoot(resolved.worktreePath);
      repoLabel = resolved.repo;
      if (!repoRoot) {
        res.json({ refs: [], heads: [], tags: [], head: "", repo: repoLabel, note: "目标 worktree 不在 git 仓库中。" });
        return;
      }
    } else {
      const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
      if (!fs.existsSync(groupDir)) {
        res.json({ refs: [], heads: [], tags: [], head: "", note: "群产物目录不存在。" });
        return;
      }
      repoRoot = findGitRoot(groupDir);
      if (!repoRoot) {
        res.json({ refs: [], heads: [], tags: [], head: "", note: "目标目录不在 git 仓库中。" });
        return;
      }
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
      repo: repoLabel,
    });
  });

  // 分支 vs 分支 diff:返回 `base..head` 之间的变更文件清单 + 统计。
  // 用于 ArtifactPanel「分支对比」模式,左侧文件列表的数据来源。
  // `repo=primary|<extras.id>` 决定走哪个 worktree。
  apiRouter.get("/artifacts/:groupId/branch-diff", (req, res) => {
    const base = (req.query.base as string) || "HEAD";
    const head = (req.query.head as string) || "HEAD";
    const repoParam = req.query.repo as string | undefined;
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(base)) {
      res.status(400).json({ error: "Invalid base ref" });
      return;
    }
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(head)) {
      res.status(400).json({ error: "Invalid head ref" });
      return;
    }
    const resolved = resolveRepoWorktree(db, req.params.groupId, repoParam);
    if ("error" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const repoRoot = findGitRoot(resolved.worktreePath);
    if (!repoRoot) {
      res.json({
        repo: resolved.repo,
        base,
        head,
        files: [],
        stats: { filesChanged: 0, additions: 0, deletions: 0 },
        truncated: false,
        repoRoot: null,
        note: "目标 worktree 不在 git 仓库中。",
      });
      return;
    }

    // --name-status: status<TAB>path (rename/copy 多一列 fromPath)
    // status 第一字符:A/M/D/R/C/U 等,后跟可选 score(R100 表示 100% 相似度)
    const nsResult = spawnSync("git", ["diff", "--no-color", "--name-status", base, head], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    if (nsResult.error) {
      res.status(500).json({ error: `git diff failed: ${nsResult.error.message}` });
      return;
    }
    if (nsResult.status !== 0 && nsResult.status !== null) {
      res.status(500).json({ error: `git diff exited ${nsResult.status}`, stderr: nsResult.stderr });
      return;
    }

    // --numstat:additions<TAB>deletions<TAB>path(binary 文件两列是 "-")
    // name-status 和 numstat 输出顺序一致,按索引对齐;rename 在 numstat 里
    // 也只输出一行(新路径),与 name-status 的 toPath 对应。
    const numResult = spawnSync("git", ["diff", "--no-color", "--numstat", base, head], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    if (numResult.error) {
      res.status(500).json({ error: `git diff --numstat failed: ${numResult.error.message}` });
      return;
    }
    if (numResult.status !== 0 && numResult.status !== null) {
      res.status(500).json({ error: `git diff --numstat exited ${numResult.status}`, stderr: numResult.stderr });
      return;
    }

    const nsLines = nsResult.stdout.split("\n").filter(Boolean);
    const numLines = numResult.stdout.split("\n").filter(Boolean);

    type ChangedFile = {
      path: string;
      status: string; // 单字符:A/M/D/R/C 等(去 score)
      additions: number;
      deletions: number;
      fromPath?: string; // rename/copy 的源路径
    };
    const files: ChangedFile[] = [];

    for (let i = 0; i < nsLines.length; i++) {
      const nsLine = nsLines[i];
      const numLine = numLines[i] || "";
      const nsParts = nsLine.split("\t");
      const statusRaw = nsParts[0] || "";
      const status = statusRaw[0] || "?";
      let toPath = "";
      let fromPath: string | undefined;
      if (status === "R" || status === "C") {
        fromPath = nsParts[1];
        toPath = nsParts[2] || nsParts[1] || "";
      } else {
        toPath = nsParts[1] || "";
      }
      const numMatch = numLine.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      let additions = 0;
      let deletions = 0;
      if (numMatch) {
        additions = numMatch[1] === "-" ? 0 : parseInt(numMatch[1], 10);
        deletions = numMatch[2] === "-" ? 0 : parseInt(numMatch[2], 10);
      }
      files.push({ path: toPath, status, additions, deletions, fromPath });
    }

    const stats = files.reduce(
      (acc, f) => ({
        filesChanged: acc.filesChanged + 1,
        additions: acc.additions + f.additions,
        deletions: acc.deletions + f.deletions,
      }),
      { filesChanged: 0, additions: 0, deletions: 0 },
    );

    // 文件数过多时截断,避免前端一次性渲染爆炸(单文件 diff 仍可单独加载)
    const MAX_FILES = 500;
    let truncated = false;
    let visible = files;
    if (files.length > MAX_FILES) {
      visible = files.slice(0, MAX_FILES);
      truncated = true;
    }

    res.json({
      repo: resolved.repo,
      base,
      head,
      files: visible,
      stats,
      truncated,
      repoRoot,
    });
  });

  // 取任意 ref 下某文件的内容,泛化 /original(那个只取 base 侧 + 只对
  // primary worktree)。前端的「分支对比」DiffEditor 用它分别取 base 和 head
  // 两侧内容。binary 文件 git show 会输出原始字节,这里仍以 utf-8 返回,
  // 前端按 size 判断走 binary 降级路径(同 /content)。
  apiRouter.get("/artifacts/:groupId/content-at-ref", (req, res) => {
    const filePath = req.query.path as string;
    const ref = (req.query.ref as string) || "HEAD";
    const repoParam = req.query.repo as string | undefined;
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(ref)) {
      res.status(400).json({ error: "Invalid ref" });
      return;
    }
    // 防穿越:git show <ref>:<path> 不走文件系统,但仍拒绝绝对路径和 ..
    if (path.isAbsolute(filePath) || filePath.split("/").some((seg) => seg === "..")) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }
    const resolved = resolveRepoWorktree(db, req.params.groupId, repoParam);
    if ("error" in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const repoRoot = findGitRoot(resolved.worktreePath);
    if (!repoRoot) {
      res.json({ path: filePath, ref, content: "", note: "目标 worktree 不在 git 仓库中。" });
      return;
    }
    const result = spawnSync("git", ["show", `${ref}:${filePath}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 10000,
    });
    if (result.error) {
      res.status(500).json({ error: `git show failed: ${result.error.message}` });
      return;
    }
    if (result.status !== 0) {
      res.json({
        path: filePath,
        ref,
        content: "",
        note: result.stderr?.trim() || `file not present at ${ref}`,
      });
      return;
    }
    res.json({ path: filePath, ref, content: result.stdout });
  });
}
