/**
 * rotom repo — 内置 repo bare clone + git worktree 缓存管理。
 *
 * 所有命令在本机 FS 操作(`~/.rotom/repos/<repo-id>.git/`),不需要 agent。
 * 与 master/executor 一样属于 "本机维护命令"。
 *
 * 子命令:
 *   list                          列出所有 bare clone + 各自 worktree 数 + 磁盘占用
 *   prune [--remove-orphans]      清理孤儿 worktree 元数据,可选删除无引用的 bare clone
 *   fetch <repo-id>               显式 git fetch --prune 某 bare clone
 *   remove <repo-id>              删除 bare clone(要求无活跃 worktree)
 */

import { parseArgs, fail } from "./common.js";
import {
  listBareClones,
  fetchBareClone,
  removeBareClone,
  pruneRepoCache,
  REPOS_ROOT,
} from "../executor/repo-cache.js";

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}

export function cmdRepo(rest: string[], flags: Record<string, unknown>): void {
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case "list":      return cmdList(flags);
    case "prune":     return cmdPrune(args, flags);
    case "fetch":     return cmdFetch(args, flags);
    case "remove":    return cmdRemove(args, flags);
    default:
      fail(`unknown repo subcommand: ${sub ?? "(none)"}\nUsage: rotom repo <list|prune|fetch|remove>`);
  }
}

function cmdList(_flags: Record<string, unknown>): void {
  const clones = listBareClones();
  if (clones.length === 0) {
    process.stdout.write(`No bare clones in ${REPOS_ROOT}\n`);
    return;
  }
  process.stdout.write(`Bare clone cache: ${REPOS_ROOT}\n\n`);
  for (const c of clones) {
    process.stdout.write(`${c.repoId}  (${humanBytes(c.sizeBytes)}, ${c.worktrees.length} worktree${c.worktrees.length === 1 ? "" : "s"})\n`);
    for (const w of c.worktrees) {
      process.stdout.write(`  - ${w.branch || "(detached)"}  ${w.path}\n`);
    }
  }
}

function cmdPrune(args: string[], _flags: Record<string, unknown>): void {
  const removeOrphans = args.includes("--remove-orphans");
  const r = pruneRepoCache({ removeOrphans });
  process.stdout.write(`Pruned ${r.prunedWorktrees} orphan worktree(s).\n`);
  if (r.removedClones.length > 0) {
    process.stdout.write(`Removed orphan bare clones:\n`);
    for (const id of r.removedClones) process.stdout.write(`  - ${id}\n`);
  }
}

function cmdFetch(args: string[], _flags: Record<string, unknown>): void {
  const repoId = args[0];
  if (!repoId) fail("rotom repo fetch <repo-id>: missing repo-id");
  const r = fetchBareClone(repoId);
  if (!r.ok) fail(`fetch failed: ${r.output}`);
  process.stdout.write(r.output || `repo ${repoId} fetched.\n`);
}

function cmdRemove(args: string[], _flags: Record<string, unknown>): void {
  const repoId = args[0];
  if (!repoId) fail("rotom repo remove <repo-id>: missing repo-id");
  const r = removeBareClone(repoId);
  if (!r.ok) fail(r.error || `remove failed for ${repoId}`);
  process.stdout.write(`Removed bare clone ${repoId}.\n`);
}
