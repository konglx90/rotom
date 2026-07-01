/**
 * Master 侧的 worktree 扫描(只读)。
 *
 * worktree 物理上在 executor 本机(`~/.rotom/repos/`),但 master 与 executor
 * 同机部署时可直接读 FS 暴露给 Dashboard。跨机器时本模块返回空列表(本机无缓存)。
 *
 * 不依赖 executor/repo-cache.ts(那是 executor 侧 spawn git 的模块),这里独立
 * 实现 scan 逻辑,保持 master/executor 模块边界清晰。算法与 repo-cache 一致:
 *   - repoId = SHA-1(归一化 URL) 前 12 位
 *   - repoName = URL 最后一段(去 .git)
 *   - bare 目录名 = <repoName>-<repoId8>.git
 *   - worktree 根 = <repoName>-<repoId8>-wt/<slot>/
 *
 * slot 推算:group 模式 = `group-<groupId8>`,issue 模式 = `<issueId8>`。
 * Dashboard 用这个推算"当前 group 的 worktree 应该在哪"。
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeshDb } from "./db.js";

const REPOS_ROOT = path.join(os.homedir(), ".rotom", "repos");

export function repoIdFor(url: string): string {
  let u = url.trim();
  if (u.endsWith(".git")) u = u.slice(0, -4);
  u = u.replace(/^ssh:\/\/([^@]+@)?/, "").replace(/^https?:\/\//, "");
  u = u.replace(/^git@/, "").replace(/\/$/, "");
  return createHash("sha1").update(u).digest("hex").slice(0, 12);
}

export function repoNameFor(url: string): string {
  let u = url.trim();
  if (u.endsWith(".git")) u = u.slice(0, -4);
  u = u.split("?")[0].split("#")[0].replace(/\/$/, "");
  const last = u.split("/").pop() || "repo";
  return last || "repo";
}

/** bare clone 路径(不查 FS,只算)。 */
export function barePathForUrl(url: string): string {
  const repoId = repoIdFor(url);
  const repoName = repoNameFor(url);
  return path.join(REPOS_ROOT, `${repoName}-${repoId.slice(0, 8)}.git`);
}

/** worktree 路径(不查 FS,只算)。slot 由调用方决定(group-<groupId8> 或 <issueId8>)。 */
export function worktreePathForUrl(url: string, slot: string): string {
  const repoId = repoIdFor(url);
  const repoName = repoNameFor(url);
  return path.join(REPOS_ROOT, `${repoName}-${repoId.slice(0, 8)}-wt`, slot);
}

/** 推算 group 模式下某 group 的 worktree 路径。 */
export function groupWorktreePath(url: string, groupId: string): string {
  return worktreePathForUrl(url, `group-${groupId.slice(0, 8)}`);
}

/** 一个 worktree 的信息(从 `git worktree list` 解析)。 */
export interface WorktreeInfo {
  /** worktree 绝对路径。 */
  path: string;
  /** 当前 checkout 的分支(detached 时为空)。 */
  branch: string;
  /** HEAD commit 短 hash。 */
  head: string;
}

/** 一个 repo(bare clone)及其所有 worktree。 */
export interface RepoScanEntry {
  /** 完整 repoKey(目录名,含 repoName + repoId8),如 "kael-trade-h5-1a4fb1fa"。 */
  repoKey: string;
  /** 仓库名(从 URL 提取)。 */
  repoName: string;
  /** bare clone 路径。 */
  barePath: string;
  /** 该 repo 的所有 worktree(不含 bare 自己)。 */
  worktrees: WorktreeInfo[];
  /** bare clone 磁盘占用(字节)。 */
  sizeBytes: number;
}

function runGitSync(args: string[], opts?: { cwd?: string }): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd: opts?.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: r.status === 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function dirSize(p: string): number {
  let total = 0;
  try {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try { total += fs.statSync(full).size; } catch { /* skip */ }
        }
      }
    };
    walk(p);
  } catch { /* skip */ }
  return total;
}

/**
 * 扫描本机 `~/.rotom/repos/`,列出所有 bare clone 及其 worktree。
 * 本机无 repos 目录(跨机器部署 master 不在 executor 机器)时返回空数组。
 */
export function scanAllRepos(): RepoScanEntry[] {
  if (!fs.existsSync(REPOS_ROOT)) return [];
  const entries = fs.readdirSync(REPOS_ROOT, { withFileTypes: true });
  const result: RepoScanEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(".git")) continue;
    const repoKey = e.name.slice(0, -4); // 去 .git
    const bp = path.join(REPOS_ROOT, e.name);
    // repoName = 去掉最后一段 -<repoId8>
    const lastDash = repoKey.lastIndexOf("-");
    const repoName = lastDash > 0 ? repoKey.slice(0, lastDash) : repoKey;

    const wtList = runGitSync(["worktree", "list", "--porcelain"], { cwd: bp });
    const worktrees: WorktreeInfo[] = [];
    if (wtList.ok) {
      let cur: Partial<WorktreeInfo> = {};
      for (const line of wtList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (cur.path) worktrees.push(cur as WorktreeInfo);
          cur = { path: line.slice("worktree ".length), branch: "", head: "" };
        } else if (line.startsWith("HEAD ")) {
          cur.head = line.slice("HEAD ".length).slice(0, 8);
        } else if (line.startsWith("branch ")) {
          const ref = line.slice("branch ".length);
          cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
        } else if (line === "") {
          if (cur.path) worktrees.push(cur as WorktreeInfo);
          cur = {};
        }
      }
      if (cur.path) worktrees.push(cur as WorktreeInfo);
    }
    // 第一条是 bare clone 自己,过滤掉
    const realWorktrees = worktrees.filter(w => !w.path.endsWith(".git"));

    result.push({
      repoKey,
      repoName,
      barePath: bp,
      worktrees: realWorktrees,
      sizeBytes: dirSize(bp),
    });
  }
  return result;
}

/**
 * 推算某 group 的 worktree 信息(用于 Dashboard 显示"当前 worktree")。
 *
 * 返回:
 *  - 若 group 没配 repo_url → null
 *  - 若配了 → { url, branch, mode, primaryPath, extraRepos[], exists }
 *    primaryPath 是推算路径(group 模式 slot = group-<groupId8>);
 *    exists 表示该路径在本机 FS 是否已存在(executor 是否已创建)。
 */
export function resolveGroupWorktreeInfo(
  db: MeshDb,
  groupId: string,
): {
  url: string;
  branch: string | null;
  mode: "group" | "issue";
  primaryPath: string;
  primaryExists: boolean;
  extras: { id: string; url: string; branch: string | null; mountPath: string; path: string; exists: boolean }[];
} | null {
  const group = db.getGroupById(groupId);
  if (!group) return null;
  const url = group.repo_url?.trim();
  if (!url) return null;
  const branch = group.repo_default_branch?.trim() || null;
  const mode = group.worktree_mode === "issue" ? "issue" : "group";
  const slot = mode === "group" ? `group-${groupId.slice(0, 8)}` : "issue-mode";
  const primaryPath = worktreePathForUrl(url, slot);
  const primaryExists = fs.existsSync(primaryPath);

  let extras: { id: string; url: string; branch: string | null; mountPath: string; path: string; exists: boolean }[] = [];
  if (group.extra_repos) {
    try {
      const parsed = JSON.parse(group.extra_repos) as unknown;
      if (Array.isArray(parsed)) {
        extras = parsed
          .filter((e): e is { id: string; url: string; branch?: string; mountPath: string } =>
            !!e && typeof e === "object" && typeof (e as any).id === "string" && typeof (e as any).url === "string" && typeof (e as any).mountPath === "string")
          .map(e => {
            const extraSlot = mode === "group" ? `group-${groupId.slice(0, 8)}` : "issue-mode";
            const p = worktreePathForUrl(e.url, extraSlot);
            return {
              id: e.id,
              url: e.url,
              branch: typeof e.branch === "string" && e.branch ? e.branch : null,
              mountPath: e.mountPath,
              path: p,
              exists: fs.existsSync(p),
            };
          });
      }
    } catch { /* malformed */ }
  }

  return { url, branch, mode, primaryPath, primaryExists, extras };
}
