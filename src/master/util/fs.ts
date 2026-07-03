/**
 * File-tree walking + content-read helpers shared by artifact endpoints.
 *
 * Previously duplicated between `api/artifacts.ts` (statSync-based, follows
 * symlinks — needed so extraRepo mountPath symlinks walk as directories) and
 * `api/share.ts` (older Dirent-based copy that missed symlinked dirs). The
 * shared `walkDir` keeps the statSync behaviour; the share endpoint now
 * benefits from the same symlink handling.
 */

import fs from "node:fs";
import path from "node:path";
import { toBeijing } from "../../shared/time.js";

export interface FileEntry {
  name: string;
  path: string;       // relative to base
  absPath: string;
  size: number;      // 0 for directories
  modifiedTime: string;
  type: "file" | "directory";
  children?: FileEntry[];
}

/** Files we serve back as base64 (everything else is read as utf-8 text). */
export const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip",
]);

/** Single-file content cap. Larger files are returned as a placeholder string. */
export const MAX_CONTENT_SIZE = 500 * 1024;

/**
 * Recursive directory walk. Skips dotfiles and `node_modules`. Uses
 * `fs.statSync` (follows symlinks) so symlinked directories are walked into
 * rather than reported as files. Sorts directories-first, then by name.
 */
export function walkDir(dir: string, base: string): FileEntry[] {
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

export type FileContentResult =
  | { kind: "ok"; content: string; type: "text" | "binary"; size: number }
  | { kind: "missing" }
  | { kind: "too-large"; size: number }
  | { kind: "outside-base" };

/**
 * Resolve `relPath` against `baseDir`, enforce containment, and read the
 * file as either utf-8 text or base64 (per `BINARY_EXTS`). Files larger than
 * `MAX_CONTENT_SIZE` are reported as `too-large` so the caller can return the
 * placeholder text the dashboard expects.
 */
export function readFileSafely(
  baseDir: string,
  relPath: string,
): FileContentResult {
  const resolved = path.resolve(baseDir, relPath);
  if (!resolved.startsWith(path.resolve(baseDir))) return { kind: "outside-base" };
  if (!fs.existsSync(resolved)) return { kind: "missing" };
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_CONTENT_SIZE) return { kind: "too-large", size: stat.size };
  const ext = path.extname(resolved).toLowerCase();
  if (BINARY_EXTS.has(ext)) {
    const buf = fs.readFileSync(resolved);
    return { kind: "ok", content: buf.toString("base64"), type: "binary", size: stat.size };
  }
  const content = fs.readFileSync(resolved, "utf-8");
  return { kind: "ok", content, type: "text", size: stat.size };
}
