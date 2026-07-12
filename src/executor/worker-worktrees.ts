/**
 * Worker —— issue/chat 的 cwd 解析 + worktree 生命周期(从 worker.ts 拆出)。
 *
 * worker.ts 的 resolveIssueCwd / resolveRepoCwd / cleanupIssueWorktrees 三个方法
 * 是自成一组的「worktree 路径决策」逻辑(FS / path / repo-cache,不碰 worker 的
 * 任务可变状态 activeTasks / issueRepoCtxs 等),~190 行。抽成纯函数,worker.ts
 * 只保留薄薄的 delegating 方法(调用点签名不变)。
 *
 * 上下文只依赖 worker 的三个只读字段 → WorkerPathCtx。
 */

import fs from "node:fs";
import path from "node:path";
import { ensureBareCloneAsync, addWorktreeAsync, removeWorktree, getBarePathForUrl, getWorktreePathForUrl, migrateWorktree, repoNameFor } from "./repo-cache.js";
import { primaryWorktreePath, extraWorktreePath, PRIMARY_API_ID } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-executor-worker", { stream: "stderr" });

export interface WorkerPathCtx {
  workingDir: string;
  workingDirMap: Record<string, string> | undefined;
  tag: string;
}

export interface IssueRepoCtx {
  issueId?: string;
  repoUrl?: string;
  repoBranch?: string;
  extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
  worktreeMode?: string;
}

/**
 * 0. 内置 repo worktree(master 下发 repoUrl)→ 起 worktree 作 cwd。
 * 1. master 推送的 override cwd(Dashboard 配的群工作目录,本机存在才用)。
 * 2. per-group override(workingDirMap)。
 * 3. 按 groupId 派生 <workingDir>/<groupId>。
 * 4. 兜底 workingDir。
 */
export async function resolveIssueCwd(
  ctx: WorkerPathCtx,
  groupId: string | undefined,
  override?: string,
  repoCtx?: IssueRepoCtx,
): Promise<string> {
  // 0. 内置 repo(migration 051)优先级最高:master 下发 repoUrl 且 groupId 已知时,
  //    在本机起 worktree 作为 cwd。worktree 路径完全由 executor 本地决定,
  //    忽略 master 推送的 override cwd(那是 group.working_dir,worktree 模式下
  //    不再适用——agent 应在 worktree 里跑,不是 group 共享目录)。
  //    worktree 创建可能抛错(bare clone 失败等),降级到老路径让 issue/chat 至少能跑。
  //    issueId:issue 模式必须(per-issue worktree 路径);group 模式不需要(chat 可不传)。
  if (repoCtx?.repoUrl && groupId) {
    try {
      return await resolveRepoCwd(ctx, groupId, repoCtx.issueId ?? "chat", {
        repoUrl: repoCtx.repoUrl,
        repoBranch: repoCtx.repoBranch,
        extraRepos: repoCtx.extraRepos,
        worktreeMode: repoCtx.worktreeMode,
      });
    } catch (err: any) {
      log.warn(ctx.tag, `worktree setup failed for ${repoCtx.issueId ?? "chat"} in group ${groupId}, fallback to derived dir: ${err?.message ?? err}`);
    }
  }

  // 1. master 推送的 cwd(Dashboard 配置的群工作目录)—— 跨机器部署时
  //    若本机不存在该路径则静默回落本地派生,保证 worker 永远能 spawn。
  //    仅在未启 worktree 模式时生效(repoCtx 为空或失败时)。
  if (override && fs.existsSync(override)) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }

  // 2. per-group override
  if (groupId && ctx.workingDirMap?.[groupId]) {
    const mapped = ctx.workingDirMap[groupId];
    fs.mkdirSync(mapped, { recursive: true });
    return mapped;
  }
  // 3. 按 groupId 派生
  if (groupId) {
    const derived = path.join(ctx.workingDir, groupId);
    fs.mkdirSync(derived, { recursive: true });
    return derived;
  }
  // 4. 兜底
  return ctx.workingDir;
}

/**
 * 内置 repo worktree 模式:为该 (group, issue, repo) 起一个 git worktree。
 *
 * 物理布局(统一后,见 shared/paths.ts):
 *   ~/.rotom/artifacts/<groupId>/__repos/            <- group 模式容器
 *     ├── primary/         <- primaryRepo worktree (agent cwd)
 *     ├── <extraId>/       <- extraRepo worktree
 *     └── ...
 *   ~/.rotom/artifacts/<groupId>/__repos/<issueId8>/ <- issue 模式容器(per-issue)
 *     ├── primary/
 *     └── <extraId>/
 *
 * primary 与 extra 同处一个容器,extra 通过 primary 下相对 symlink
 * `repos/<id>` -> `../../<id>` 让 agent 在 cwd 内直接访问。symlink 而非直接在
 * primary 下 clone,是为了让 primary 自己的 git 不会把 extraRepo 当成 untracked
 * 文件,两条 worktree 互不干扰。
 *
 * bare clone(.git 对象库)全局共享,只克隆一次;worktree 各自一份 checkout。
 * group 模式下同 group 的 issue/chat 共用一个 worktree;issue 模式完全并行。
 *
 * 迁移:旧布局把 worktree 放在 ~/.rotom/repos/<repo>-<id8>-wt/<slot>/,首次访问
 * 时 `git worktree move` 到新位置(复用 checkout);失败(占用)则在新位置重新 checkout。
 */
async function resolveRepoCwd(
  ctx: WorkerPathCtx,
  groupId: string,
  issueId: string,
  repoCtx: { repoUrl: string; repoBranch?: string; extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[]; worktreeMode?: string },
): Promise<string> {
  const mode = repoCtx.worktreeMode === "issue" ? "issue" : "group";
  const groupId8 = groupId.slice(0, 8);
  const issueId8 = issueId.slice(0, 8);
  // 旧布局 slot(仅迁移时算旧路径用):group 模式 group-<groupId8>,issue 模式 <issueId8>
  const oldSlot = mode === "group" ? `group-${groupId8}` : issueId8;
  // issue 模式才需要 issueId8 算路径;group 模式 issueId 不参与路径
  const pathIssueId8 = mode === "issue" ? issueId8 : undefined;

  // primary worktree —— 目录名用仓库名(对人可读:__repos/wario 而非 __repos/primary)
  const { barePath: primaryBare } = await ensureBareCloneAsync(repoCtx.repoUrl);
  const primaryDirName = repoNameFor(repoCtx.repoUrl);
  const primaryWt = primaryWorktreePath(groupId, mode, primaryDirName, pathIssueId8);
  // 派生分支后缀:group 模式用 groupId8(每 group 独立),issue 模式用 issueId8。
  // 避免 group 模式 issueId8 缺省时退化成 "tmp"(出现 master-rotom-tmp 这种无名分支)。
  const primarySuffix = mode === "group" ? groupId8 : issueId8;
  // 迁移:旧布局(-wt)→ 新;中间态(__repos/primary,改名为仓库名前)→ 新。复用 checkout,失败回落新建。
  await migrateWorktree(primaryBare, getWorktreePathForUrl(repoCtx.repoUrl, oldSlot), primaryWt);
  await migrateWorktree(primaryBare, primaryWorktreePath(groupId, mode, PRIMARY_API_ID, pathIssueId8), primaryWt);
  // addWorktreeAsync 创建派生分支 <branch>-rotom-<suffix> 并 checkout 到该分支。
  // 不再 checkoutWorktreeAsync 切原分支——git worktree 不允许同一分支在多个
  // worktree 同时 checkout(多 group 同 URL 同分支会冲突)。每个 group/issue 在
  // 自己的派生分支上工作,互不干扰,agent 可 push 该派生分支或 merge 回原分支。
  const primaryBranch = repoCtx.repoBranch;
  await addWorktreeAsync(primaryBare, primaryWt, primaryBranch, primarySuffix);

  // extraRepo worktrees + symlink(挂到 primary 的 mountPath)
  for (const extra of repoCtx.extraRepos ?? []) {
    const { barePath: extraBare } = await ensureBareCloneAsync(extra.url);
    const extraWt = extraWorktreePath(groupId, extra.id, mode, pathIssueId8);
    const extraSuffix = primarySuffix;
    const extraBranch = extra.branch;
    await migrateWorktree(extraBare, getWorktreePathForUrl(extra.url, oldSlot), extraWt);
    await addWorktreeAsync(extraBare, extraWt, extraBranch, extraSuffix);
    // mountPath 形如 "repos/<repo-B>";在 primary 下建相对 symlink
    // primary 在 <container>/<repoName>/,extra 在 <container>/<extraId>/
    // 相对路径:../../<extraId>(从 primary/repos 上到 primary、上到 container、进 extra)
    if (extra.mountPath) {
      const linkPath = path.join(primaryWt, extra.mountPath);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      try { fs.rmSync(linkPath, { force: true }); } catch { /* 可能不存在 */ }
      const target = path.relative(path.dirname(linkPath), extraWt);
      try {
        fs.symlinkSync(target, linkPath, "dir");
      } catch (err: any) {
        log.warn(ctx.tag, `symlink create failed for ${linkPath}: ${err?.message ?? err}`);
      }
    }
  }

  return primaryWt;
}

/**
 * 清理某 issue 的所有 worktree(primary + extras)。issue 完成/取消/删除时调。
 * bare clone 不删(全局复用)。失败只 warn,不阻塞 issue 流程。
 *
 * group 模式:worktree 是共享的(<groupDir>/__repos/primary/),不按 issue 清理 ——
 *   删了别的 issue 也用不了。留给 group 删除 / `rotom repo prune` 手动清。
 * issue 模式:清 per-issue worktree(<groupDir>/__repos/<issueId8>/)。
 *
 * 跨机器部署时只能清理本机的 worktree;其它机器的 issue 完成时各自清理自己的。
 */
export function cleanupIssueWorktrees(
  ctx: WorkerPathCtx,
  groupId: string | undefined,
  issueId: string | undefined,
  repoCtx?: { repoUrl?: string; extraRepos?: { id: string; url: string }[]; worktreeMode?: string },
): void {
  if (!groupId || !issueId || !repoCtx?.repoUrl) return;
  // group 模式共享 worktree,不按 issue 清
  if (repoCtx.worktreeMode !== "issue") return;
  // issue 模式:清 ~/.rotom/artifacts/<groupId>/__repos/<issueId8>/
  const issueId8 = issueId.slice(0, 8);
  const primaryDirName = repoNameFor(repoCtx.repoUrl);

  // primary
  try {
    const barePath = getBarePathForUrl(repoCtx.repoUrl);
    const primaryWt = primaryWorktreePath(groupId, "issue", primaryDirName, issueId8);
    removeWorktree(barePath, primaryWt);
    // 兼容:新路径没有时尝试清中间态(__repos/primary)与旧路径(-wt)
    if (!fs.existsSync(primaryWt)) {
      removeWorktree(barePath, primaryWorktreePath(groupId, "issue", PRIMARY_API_ID, issueId8));
      removeWorktree(barePath, getWorktreePathForUrl(repoCtx.repoUrl, issueId8));
    }
  } catch (err: any) {
    log.warn(ctx.tag, `cleanup primary worktree failed for ${issueId}: ${err?.message ?? err}`);
  }
  // extras
  for (const extra of repoCtx.extraRepos ?? []) {
    try {
      const barePath = getBarePathForUrl(extra.url);
      const wt = extraWorktreePath(groupId, extra.id, "issue", issueId8);
      removeWorktree(barePath, wt);
      if (!fs.existsSync(wt)) {
        removeWorktree(barePath, getWorktreePathForUrl(extra.url, issueId8));
      }
    } catch (err: any) {
      log.warn(ctx.tag, `cleanup extra worktree ${extra.id} failed for ${issueId}: ${err?.message ?? err}`);
    }
  }
  // 顺手清空的 issue 容器目录
  try {
    const container = path.join(primaryWorktreePath(groupId, "issue", primaryDirName, issueId8), "..");
    if (fs.existsSync(container) && fs.readdirSync(container).length === 0) {
      fs.rmSync(container, { recursive: true, force: true });
    }
  } catch { /* 无所谓 */ }
}
