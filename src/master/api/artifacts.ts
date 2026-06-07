import { type Router as ExpressRouter } from "express";
import path from "node:path";
import fs from "node:fs";
import type { MeshDb } from "../db.js";
import { resolveGroupArtifactRoot } from "../group-paths.js";

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
        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            path: relPath,
            absPath: fullPath,
            size: 0,
            modifiedTime: fs.statSync(fullPath).mtime.toISOString(),
            type: "directory",
            children: walkDir(fullPath, base),
          });
        } else if (item.isFile()) {
          const stat = fs.statSync(fullPath);
          entries.push({
            name: item.name,
            path: relPath,
            absPath: fullPath,
            size: stat.size,
            modifiedTime: stat.mtime.toISOString(),
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

    res.json({
      root: groupDir,
      files: walkDir(groupDir, groupDir),
    });
  });

  apiRouter.get("/artifacts/:groupId/content", (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
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
    let cursor = path.dirname(resolved);
    let repoRoot: string | null = null;
    const stopAt = path.parse(cursor).root;
    while (cursor && cursor !== stopAt) {
      if (fs.existsSync(path.join(cursor, ".git"))) {
        repoRoot = cursor;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!repoRoot) {
      res.json({ path: filePath, base, repoRoot: null, content: "", note: "目标文件不在 git 仓库中。" });
      return;
    }
    const relInRepo = path.relative(repoRoot, resolved);
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
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
    let cursor = path.dirname(resolved);
    let repoRoot: string | null = null;
    const stopAt = path.parse(cursor).root;
    while (cursor && cursor !== stopAt) {
      if (fs.existsSync(path.join(cursor, ".git"))) {
        repoRoot = cursor;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!repoRoot) {
      res.json({ path: filePath, base, repoRoot: null, diff: "", note: "目标文件不在 git 仓库中，无法计算 diff。" });
      return;
    }
    const relInRepo = path.relative(repoRoot, resolved);
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
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
}
