/**
 * Shared helpers for resolving per-group on-disk paths.
 *
 * Centralises the "where does this group's working directory live" rule so
 * both the artifacts REST endpoints and the web-terminal PTY hub agree on
 * the same cwd. Previously this lived inline in api.ts; pulling it out
 * avoids importing api.ts (and Express) from non-HTTP modules.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeshDb } from "./db.js";
import type { IssueRow, AgentRow } from "./db/types.js";

// 路径常量 / 默认目录统一来自 shared/paths.ts(master 与 executor 共用同一真相源)。
// 这里 re-export 保留旧导入路径(`import { ARTIFACTS_ROOT } from "../group-paths.js"`)。
export {
  ARTIFACTS_ROOT,
  LEGACY_RESULTS_ROOT,
  REPOS_ROOT,
  defaultGroupWorkingDir,
  groupArtifactsDir,
  primaryWorktreePath,
  extraWorktreePath,
  groupReposContainer,
  extraSymlinkTarget,
} from "../shared/paths.js";
import { LEGACY_RESULTS_ROOT, defaultGroupWorkingDir } from "../shared/paths.js";

/**
 * Resolve the directory the artifacts panel / terminal should use for a group.
 *
 * Prefers the group's configured `working_dir` (an absolute path the agent
 * actually runs in), falling back to the default `~/.rotom/artifacts/<groupId>`.
 *
 * Backward-compat: if neither override nor the default artifacts dir exists
 * on disk, fall back to the legacy `~/.rotom/results/<groupId>` (covers
 * `working_dir` values persisted against the pre-rename path).
 */
export function resolveGroupArtifactRoot(db: MeshDb, groupId: string): string {
  const group = db.getGroupById(groupId);
  const dir = group?.working_dir?.trim();
  if (dir && path.isAbsolute(dir)) {
    if (fs.existsSync(dir)) return dir;
    // Stored working_dir is stale — fall through to the default + legacy
    // fallback below so a pre-rename group keeps resolving.
  }

  const defaultDir = defaultGroupWorkingDir(groupId);
  if (fs.existsSync(defaultDir)) return defaultDir;

  const legacyDir = path.join(LEGACY_RESULTS_ROOT, groupId);
  if (fs.existsSync(legacyDir)) return legacyDir;

  return defaultDir;
}

/**
 * 内置 repo 上下文(migration 051)。master 在 dispatch issue 时调这个,
 * 解析该 issue 实际使用的 repo 配置,随 WS 消息下发给 executor。
 *
 * 优先级:
 *  - issue.repo_url 非空 → 用 issue 级覆盖(连同 issue.repo_branch)
 *  - 否则 → 用 group.repo_url + group.repo_default_branch + group.extra_repos
 *  - group 也没配 → 返回 null(worker 走老路径,无 worktree)
 *
 * extraRepos 只在 group 级定义(issue 不支持覆盖 extra),解析失败(JSON 损坏)时
 * 静默忽略该 extra,不影响 primary worktree 创建。
 */
export function resolveIssueRepoCtx(
  db: MeshDb,
  issue: IssueRow,
): { repoUrl: string; repoBranch?: string; extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[]; worktreeMode?: string } | null {
  const group = db.getGroupById(issue.group_id);
  if (!group) return null;

  const repoUrl = issue.repo_url?.trim() || group.repo_url?.trim() || "";
  if (!repoUrl) return null;

  const repoBranch = issue.repo_branch?.trim() || group.repo_default_branch?.trim() || undefined;

  // worktree_mode: 'issue' 显式 opt-in,其余(含 null)都归 'group'(默认轻量模式)
  const worktreeMode = group.worktree_mode === "issue" ? "issue" : "group";

  let extraRepos: { id: string; url: string; branch?: string; mountPath: string }[] | undefined;
  if (group.extra_repos) {
    try {
      const parsed = JSON.parse(group.extra_repos) as unknown;
      if (Array.isArray(parsed)) {
        extraRepos = parsed
          .filter((e): e is { id: string; url: string; branch?: string; mountPath: string } =>
            !!e && typeof e === "object"
            && typeof (e as any).id === "string" && (e as any).id
            && typeof (e as any).url === "string" && (e as any).url
            && typeof (e as any).mountPath === "string" && (e as any).mountPath)
          .map(e => ({
            id: e.id,
            url: e.url,
            branch: typeof e.branch === "string" && e.branch ? e.branch : undefined,
            mountPath: e.mountPath,
          }));
        if (extraRepos.length === 0) extraRepos = undefined;
      }
    } catch { /* malformed JSON — ignore extras */ }
  }

  return { repoUrl, repoBranch, extraRepos, worktreeMode };
}

/**
 * 判定 agent 是否与 master 同机器。worktree 模式(migration 051)只在同机生效:
 * executor 在本机维护 bare clone + worktree,跨机器时 master 不下发 repoCtx,
 * worker 回退到老路径(<base>/<groupId>),避免跨机 FS 协调。
 *
 * 判定优先级:
 *  1. agent.hostname 与本机 os.hostname() 完全相等 → 同机
 *  2. agent.endpoint 是 ws://127.0.0.1 / ws://localhost → 同机
 *  3. 否则 → 跨机
 */
export function isAgentLocalToMaster(agent: AgentRow | undefined): boolean {
  if (!agent) return false;
  const localHostname = os.hostname();
  if (agent.hostname && agent.hostname === localHostname) return true;
  if (agent.endpoint) {
    try {
      const u = new URL(agent.endpoint);
      if (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "0.0.0.0") return true;
    } catch { /* malformed endpoint — ignore */ }
  }
  return false;
}

/**
 * 解析 group 级 repo 上下文(chat 路径用,无 issue)。与 resolveIssueRepoCtxLocalOnly
 * 类似但不依赖 issue row——只看 group 配置 + agent 同机判定。
 *
 * chat 路径:master dispatch a2a_message 时调这个,把 repoCtx 注入消息,worker 收到后
 * 在 resolveChatCwd 里走 group 模式 worktree(共享 worktree,不依赖 issueId)。
 */
export function resolveGroupRepoCtxLocalOnly(
  db: MeshDb,
  groupId: string,
  agentName: string,
): { repoUrl: string; repoBranch?: string; extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[]; worktreeMode?: string } | null {
  const group = db.getGroupById(groupId);
  if (!group) return null;
  const repoUrl = group.repo_url?.trim() || "";
  if (!repoUrl) return null;
  const agent = db.getAgentByName(agentName);
  if (!isAgentLocalToMaster(agent)) return null;
  const repoBranch = group.repo_default_branch?.trim() || undefined;
  const worktreeMode = group.worktree_mode === "issue" ? "issue" : "group";

  let extraRepos: { id: string; url: string; branch?: string; mountPath: string }[] | undefined;
  if (group.extra_repos) {
    try {
      const parsed = JSON.parse(group.extra_repos) as unknown;
      if (Array.isArray(parsed)) {
        extraRepos = parsed
          .filter((e): e is { id: string; url: string; branch?: string; mountPath: string } =>
            !!e && typeof e === "object"
            && typeof (e as any).id === "string" && (e as any).id
            && typeof (e as any).url === "string" && (e as any).url
            && typeof (e as any).mountPath === "string" && (e as any).mountPath)
          .map(e => ({
            id: e.id,
            url: e.url,
            branch: typeof e.branch === "string" && e.branch ? e.branch : undefined,
            mountPath: e.mountPath,
          }));
        if (extraRepos.length === 0) extraRepos = undefined;
      }
    } catch { /* malformed JSON — ignore extras */ }
  }
  return { repoUrl, repoBranch, extraRepos, worktreeMode };
}

/**
 * 解析 issue 的 repo 上下文,但只在 assignee 与 master 同机器时返回非 null。
 * 跨机器 agent 调用方拿不到 repoCtx,worker 走老路径(不启 worktree)。
 */
export function resolveIssueRepoCtxLocalOnly(
  db: MeshDb,
  issue: IssueRow,
): { repoUrl: string; repoBranch?: string; extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[] } | null {
  if (!issue.assigned_to) return null;
  const agent = db.getAgentByName(issue.assigned_to);
  if (!isAgentLocalToMaster(agent)) return null;
  return resolveIssueRepoCtx(db, issue);
}

/**
 * Resolve the working directory for a specific (group, agent) pair.
 *
 * Three-tier fallback:
 *  1. per-(group, agent) override in `group_member_settings`
 *  2. group's `working_dir` (when set to an absolute path)
 *  3. `~/.rotom/artifacts/<groupId>` default (with legacy results fallback
 *     for groups whose data migration was incomplete)
 *
 * Used at issue-assignment time to compute the cwd that should be recorded
 * on the issue. Executor workers continue to use their own per-group mapping
 * (`executor.config.json.workingDirMap`); this function is the master-side
 * authoritative resolution only.
 */
export function resolveGroupAgentWorkingDir(
  db: MeshDb,
  groupId: string,
  agentName: string,
): string {
  const override = db.getGroupMemberSetting(groupId, agentName);
  if (override && fs.existsSync(override)) return override;

  const group = db.getGroupById(groupId);
  const dir = group?.working_dir?.trim();
  if (dir && path.isAbsolute(dir) && fs.existsSync(dir)) return dir;

  const defaultDir = defaultGroupWorkingDir(groupId);
  if (fs.existsSync(defaultDir)) return defaultDir;

  const legacyDir = path.join(LEGACY_RESULTS_ROOT, groupId);
  if (fs.existsSync(legacyDir)) return legacyDir;

  return defaultDir;
}
