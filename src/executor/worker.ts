/**
 * ExecutorWorker — 单个数字员工的完整生命周期
 *
 * 每个 worker 拥有独立的 WebSocket 连接、身份、CLI 后端和任务队列。
 * 职责:Issue 执行 + 群聊回复。
 *
 * 本文件是 integration glue:WS 路由(handleMessage)、共享可变状态
 * (activeTasks / pendingApprovals / pendingAppends / ws / sessions)、
 * 以及所有 handler 共用的 helpers(send* / agentEnv / resolveIssueCwd /
 * sendSessionSnapshot)。各执行域拆出独立文件:
 *   • SessionStore      → session-store.ts(持久化层)
 *   • WorkerConnection  → worker-connection.ts(WS / 心跳 / 重连)
 *   • IssueHandler      → worker-issue.ts(issue 执行循环)
 *   • ChatHandler       → worker-chat.ts(群聊回复 + 协作启动)
 */

import { WebSocket } from "ws";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { CliExecutor } from "./cli-executor.js";
import type { TokenUsage } from "../shared/protocol.js";
import { composePrompt } from "../shared/prompt-composer.js";
import { parseAgentProfile, type AgentProfile } from "../shared/agent-profile.js";
import { SessionStore } from "./session-store.js";
import { WorkerConnection } from "./worker-connection.js";
import { IssueHandler } from "./worker-issue.js";
import { ChatHandler } from "./worker-chat.js";
import { ensureBareCloneAsync, addWorktreeAsync, removeWorktree, getBarePathForUrl, getWorktreePathForUrl, migrateWorktree, repoNameFor } from "./repo-cache.js";
import { primaryWorktreePath, extraWorktreePath, PRIMARY_API_ID } from "../shared/paths.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-executor-worker", { stream: "stderr" });

// ── Config ──────────────────────────────────────────────────────────────

export interface WorkerConfig {
  /** Agent 名称 */
  name: string;
  /**
   * 认证 token。OPC 本机模式下可省略 —— master 端 isLoopback(remoteAddr)
   * 命中时会走 authenticateLocal 直通(`src/master/auth.ts`),无需 mesh_token。
   * 跨机连接远程 master 时仍然必填。
   */
  token?: string;
  /** CLI 工具名 (不填则 auto-detect) */
  cliTool?: string;
  /** Agent 档案 */
  profile?: {
    category?: string;
    position?: string;
    bio?: string;
  };
  /**
   * 工作目录 —— 必填,本机可读。Agent 的实际 spawn cwd 是
   * `<workingDir>/<groupId>`(groupId 来自 WS 消息),`workingDir` 本身是**base 目录**。
   * 派生后的 `<workingDir>/<groupId>/` 在 executor 启动时按需 mkdir -p。
   *
   * 跨机器部署时,每台 executor 各自配置自己机器上的 base 路径,
   * 不需要与 master 共享 FS —— groupId 是逻辑标识,各机器各自的 `<base>/<groupId>`
   * 物理隔离。
   *
   * index.ts 启动时校验 base 路径存在 / 可读,缺失或不合法会 fail-fast。
   * Agent 在派生后的 cwd 下**只读**访问:Read / Grep / Glob / Bash(只读命令)允许,
   * Write / Edit 等写盘工具禁止。
   */
  workingDir?: string;
  /**
   * Per-group 路径覆盖(可选)。键是 groupId,值是本机绝对路径。
   * 命中时直接用该路径,跳过 `<workingDir>/<groupId>` 派生。
   * 适合"同一个 executor 接多个 group、分别需要不同本地项目"的场景。
   * 示例:`{ "group-abc": "/Users/bob/projects/frontend", "group-def": "/Users/bob/projects/backend" }`
   */
  workingDirMap?: Record<string, string>;
  /** 最大并发任务数 (default: 2) */
  maxConcurrent?: number;
}

// ── Worker ──────────────────────────────────────────────────────────────

/** issue_usage_progress 推送节流窗口:执行过程中每秒最多推一次累积 usage。 */
const USAGE_THROTTLE_MS = 1000;

/**
 * 累积两份 TokenUsage 字段。各字段独立 sum,undefined 的字段保留另一份的值。
 * 用于把 executor 的单轮增量累积成跨轮总量。
 */
function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: sumIfNum(a.inputTokens, b.inputTokens),
    outputTokens: sumIfNum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sumIfNum(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: sumIfNum(a.cacheCreationTokens, b.cacheCreationTokens),
    // 成本不累积(result 终态覆盖时会一次性给准确值,中间累积无意义)
    totalCostUsd: b.totalCostUsd ?? a.totalCostUsd,
  };
}
function sumIfNum(x?: number, y?: number): number | undefined {
  if (typeof x === "number" && typeof y === "number") return x + y;
  return x ?? y;
}

export class ExecutorWorker {
  // ── Shared mutable state (touched by handlers + WS router) ────────
  // activeTasks key shape: issueId | `chat:${requestId}`
  activeTasks = new Map<string, { aborted: boolean; interrupted?: boolean; controller: AbortController }>();
  /**
   * Approvals awaiting the user's Accept/Deny. Keyed by approvalId (the same
   * id sent to Master and rendered in the dashboard). Issue cancel resolves
   * every entry for that issue to "deny" so codex can unblock and exit.
   */
  pendingApprovals = new Map<string, {
    issueId: string;
    resolve: (decision: import("./cli-executor.js").ApprovalDecision) => void;
  }>();
  /**
   * Issue 的内置 repo 上下文缓存(migration 051)。issue_assigned/continue/append
   * 收到 repoCtx 时记下,issue_cancelled 时查 map 后清理本机 worktree。
   *
   * Keyed by issueId。issue 完成/失败时不清(用户可能想保留 worktree 看产物),
   * 只在 cancelled(用户主动放弃)时清理。issue_delete 走 master DELETE API,
   * 若 assignee 是本机 agent,master 发 issue_cancelled,本机清。
   */
  issueRepoCtxs = new Map<string, { groupId?: string; repoUrl?: string; extraRepos?: { id: string; url: string }[]; worktreeMode?: string }>();
  // 已入队但尚未消费的「追加指令」。user 在 in_progress 期间提交的 prompt
  // 先攒在这里,当前一轮 CLI 收尾时(runIssueExecution 的 finally)合并起一轮新执行。
  pendingAppends = new Map<string, string[]>();
  /**
   * Token usage 累积器:每个正在执行的 issue 一条。executor 的 onUsage
   * 回调给的是**单轮增量**,这里 sum 起来做累积值,leading+trailing 1s 节流
   * 后通过 issue_usage_progress 推给 master(由 master 转发给订阅了该 issue
   * 详情的 dashboard 客户端,不落 DB)。
   *
   * 终态时(runIssueExecution 的 finally)由 flushIssueUsage 强制推一次,
   * 并用 result.usage 覆盖累积值——保证 reload 后看到的 issue.usage 与最后
   * 一次推送一致(避免 assistant 增量与 result 终态口径不一致导致数字跳变)。
   */
  private usageAccumulators = new Map<string, {
    accumulated: TokenUsage;
    lastPushAt: number;
    trailingTimer?: NodeJS.Timeout;
    dirty: boolean;
  }>();
  /** WS socket — assigned by WorkerConnection.connect(). Null until first connect. */
  ws!: WebSocket;
  stopped = false;

  // ── Config-derived readonly fields ────────────────────────────────
  readonly tag: string;
  readonly workingDir: string;
  readonly maxConcurrent: number;
  readonly cliTool: string;
  /** agents.profile 解析后缓存,供 composePrompt() 渲染 agent-role 层。
   *  初始值来自 executor.config.json,运行时收到带 agentProfile 字段的
   *  WS 消息(issue_assigned/continue/append、a2a_message)
   *  时由 setAgentProfile() 更新 —— 这是 Dashboard 编辑后下一条消息即生效的入口。 */
  agentProfile: AgentProfile | null;

  // ── Subsystems (constructed after the fields above are initialized) ──
  readonly sessions: SessionStore;
  readonly connection: WorkerConnection;
  readonly issues: IssueHandler;
  readonly chat: ChatHandler;

  constructor(
    readonly config: WorkerConfig,
    readonly executor: CliExecutor,
    readonly masterUrl: string,
    cliTool: string,
    /**
     * Rotom 主目录(通常 `~/.rotom`)。SessionStore 文件落在该目录下
     * (`<rotomHome>/sessions.json`),与 per-group cwd 派生路径**解耦**——
     * session 是 worker 全局状态,不应该跟着 groupId 散布到 `<base>/<groupId>/` 里。
     */
    readonly rotomHome: string,
    /**
     * 共享的 SessionStore 实例。executor 进程内所有 worker 必须共用同一个,
     * 否则每个 worker 各自 flush 自己的内存 map 到同一个 sessions.json,
     * 后 flush 的 worker 会覆盖先 flush 的 worker 写入的条目(典型表现:
     * 重启后某些 cliTool 的 session 「消失」)。由 index.ts 创建并传入。
     * 不传时(主要为了测试隔离)回退到自建实例。
     */
    sharedSessions?: SessionStore,
  ) {
    this.tag = `[executor:${config.name}]`;
    // workingDir 是 per-group cwd 派生的 base,完全本机解析,与 master 无关。
    // index.ts 启动时已校验存在 / 可读;此处仅做兜底默认值。
    if (!config.workingDir) {
      log.warn(this.tag, "WARN: no workingDir configured, falling back to ~/.rotom (likely not a project dir, agent may have nothing to read)");
    }
    this.workingDir = config.workingDir || path.join(os.homedir(), ".rotom");
    this.maxConcurrent = config.maxConcurrent ?? 2;
    this.cliTool = cliTool;
    this.sessions = sharedSessions ?? new SessionStore();
    this.agentProfile = parseAgentProfile(JSON.stringify(config.profile ?? null));

    // Subsystems store the worker reference only — no work in constructors.
    // Safe to construct after sessions/agentProfile are initialized.
    this.connection = new WorkerConnection(this);
    this.issues = new IssueHandler(this);
    this.chat = new ChatHandler(this);

    // 不再 mkdirSync this.workingDir —— 启动时已校验 base 存在;
    // per-group 子目录在 resolveIssueCwd() 首次解析时按需 mkdir -p。
  }

  /**
   * 解析本 issue 实际使用的 spawn cwd。优先级:
   *  1. config.workingDirMap[groupId] —— per-group 显式覆盖
   *  2. <this.workingDir>/<groupId> —— 按 groupId 派生(本机 base 下的子目录)
   *  3. this.workingDir —— groupId 缺失时的兜底(实际不该发生,master 总会带 groupId)
   *
   * 派生后 / override 命中的目录按需 mkdir -p(只读语义下,目录创建一次后
   * agent 不会再写,后续 issue 直接复用)。
   *
   * 跨机器部署安全:每台 executor 用自己的 this.workingDir,各机器各自的
   * `<base>/<groupId>` 物理隔离;master 推送的 workingDir 永远不会被用到这里。
   */
  /**
   * 解析本 issue 实际使用的 spawn cwd。优先级:
   *  0. master 推送的 cwd(Dashboard 群工作目录)优先 —— 跨机器部署时
   *     若本机不存在该路径则静默回落本地派生,保证 worker 永远能 spawn。
   *  1. repoCtx(内置 repo, migration 051):master 下发 repoUrl 时,在
   *     `<this.workingDir>/<groupId>/<issueId>/repos/primary/` 起 git worktree
   *     作为 cwd;extraRepos 各自一个 worktree,通过 symlink 挂到 primary 下。
   *     单 group 多分支天然隔离,同 URL 跨 group/issue 全局复用 bare clone。
   *  2. config.workingDirMap[groupId] —— per-group 显式覆盖
   *  3. <this.workingDir>/<groupId> —— 按 groupId 派生(本机 base 下的子目录)
   *  4. this.workingDir —— groupId 缺失时的兜底(实际不该发生,master 总会带 groupId)
   *
   * 派生后 / override 命中的目录按需 mkdir -p(只读语义下,目录创建一次后
   * agent 不会再写,后续 issue 直接复用)。
   *
   * 跨机器部署安全:每台 executor 用自己的 this.workingDir,各机器各自的
   * `<base>/<groupId>` 物理隔离;master 推送的 workingDir 永远不会被用到这里。
   *
   * @param repoCtx 内置 repo 上下文。repoUrl 非空时启用 worktree 模式;否则走 1-4 老路径。
   * @returns cwd 字符串。worktree 模式下返回 primary worktree 路径(已存在)。
   */
  async resolveIssueCwd(
    groupId: string | undefined,
    override?: string,
    repoCtx?: {
      issueId?: string;
      repoUrl?: string;
      repoBranch?: string;
      extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
      worktreeMode?: string;
    },
  ): Promise<string> {
    // 0. 内置 repo(migration 051)优先级最高:master 下发 repoUrl 且 groupId 已知时,
    //    在本机起 worktree 作为 cwd。worktree 路径完全由 executor 本地决定,
    //    忽略 master 推送的 override cwd(那是 group.working_dir,worktree 模式下
    //    不再适用——agent 应在 worktree 里跑,不是 group 共享目录)。
    //    worktree 创建可能抛错(bare clone 失败等),降级到老路径让 issue/chat 至少能跑。
    //    issueId:issue 模式必须(per-issue worktree 路径);group 模式不需要(chat 可不传)。
    if (repoCtx?.repoUrl && groupId) {
      try {
        return await this.resolveRepoCwd(groupId, repoCtx.issueId ?? "chat", {
          repoUrl: repoCtx.repoUrl,
          repoBranch: repoCtx.repoBranch,
          extraRepos: repoCtx.extraRepos,
          worktreeMode: repoCtx.worktreeMode,
        });
      } catch (err: any) {
        log.warn(this.tag, `worktree setup failed for ${repoCtx.issueId ?? "chat"} in group ${groupId}, fallback to derived dir: ${err?.message ?? err}`);
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
    if (groupId && this.config.workingDirMap?.[groupId]) {
      const mapped = this.config.workingDirMap[groupId];
      fs.mkdirSync(mapped, { recursive: true });
      return mapped;
    }
    // 3. 按 groupId 派生
    if (groupId) {
      const derived = path.join(this.workingDir, groupId);
      fs.mkdirSync(derived, { recursive: true });
      return derived;
    }
    // 4. 兜底
    return this.workingDir;
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
  private async resolveRepoCwd(
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
          log.warn(this.tag, `symlink create failed for ${linkPath}: ${err?.message ?? err}`);
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
  cleanupIssueWorktrees(
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
      log.warn(this.tag, `cleanup primary worktree failed for ${issueId}: ${err?.message ?? err}`);
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
        log.warn(this.tag, `cleanup extra worktree ${extra.id} failed for ${issueId}: ${err?.message ?? err}`);
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


  /**
   * 更新本地缓存的 agentProfile —— master 在 dispatch 时通过 WS 消息字段
   * `agentProfile` 推送 Dashboard 编辑后的最新值。worker 收到后调用本方法,
   * 下一次 composePrompt() 就会渲染新角色信息。
   *
   * JSON.stringify 比对避免无变化时刷日志。空 profile 也会更新(用户可能
   * 在 Dashboard 清空了字段,需如实下沉)。
   */
  setAgentProfile(p: AgentProfile | null): void {
    if (JSON.stringify(p) === JSON.stringify(this.agentProfile)) return;
    this.agentProfile = p;
    const sig = p
      ? `position=${p.position ?? "-"}, bio=${p.bio ? "(set)" : "-"}, category=${p.category ?? "-"}`
      : "(null)";
    log.info(this.tag, `agentProfile updated (${sig})`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    this.connection.start();
  }

  stop(): void {
    this.connection.stop();
    // SessionStore is in-memory only now; persistence lives in master DB.
  }

  // ── Message router ────────────────────────────────────────────────

  handleMessage(msg: Record<string, unknown>): void {
    // issue_assigned / continue / append 分支异步 resolve worktree(可能耗时几秒到
    // 几分钟做 bare clone)。用 void IIFE 包住,不阻塞 handleMessage 返回,其他 WS
    // 消息(心跳、chat 取消、其他 issue 进度)继续能处理。错误在 IIFE 内 catch。
    if (msg.type === "issue_assigned" || msg.type === "issue_continue" || msg.type === "issue_append") {
      void this.handleIssueRepoMsg(msg).catch((err) => {
        log.error(this.tag, "issue repo msg error:", err);
      });
      return;
    }
    if (msg.type === "auth_ok") {
      log.info(this.tag, "Authenticated");
      // Push initial SessionStore snapshot so master's DB is populated
      // (covers the legacy backfill path: entries read from sessions.json
      // get upserted into master DB on first auth). Master will then push
      // back a session_sync_push with the worker's active sessions.
      this.sendSessionSnapshot();
      this.connection.startHeartbeat();
    }

    if (msg.type === "session_sync_push") {
      // Master pushes the worker's active sessions from DB on auth. Hydrate
      // the in-memory store so subsequent chat turns can --resume.
      const entries = (msg as any).entries as Array<any> | undefined;
      if (Array.isArray(entries)) {
        this.sessions.hydrate(entries.map(e => ({
          cliTool: e.cliTool,
          groupId: e.groupId,
          sessionId: e.sessionId,
          usage: e.usage ?? undefined,
          model: e.model ?? undefined,
          cumulativeCostUsd: e.cumulativeCostUsd,
        })));
      }
      return;
    }

    if (msg.type === "auth_fail") {
      log.error(this.tag, `Auth failed: ${msg.reason}`);
      return;
    }

    // Issue assignment
    // issue_assigned / continue / append 三分支在 handleIssueRepoMsg(async)里处理,
    // 此处已被开头 void IIFE 拦截,不会走到。

    if (msg.type === "issue_created") {
      log.info(this.tag, `New issue: "${(msg as any).title}" (awaiting manual assignment)`);
    }

    // Issue cancellation — abort the in-flight CLI process if we own the task.
    if (msg.type === "issue_cancelled") {
      const issueId = (msg as any).issueId as string | undefined;
      if (!issueId) return;
      // Resolve any pending approvals for this issue as "deny" so codex can
      // unblock its parked JSON-RPC request and exit cleanly.
      for (const [approvalId, p] of this.pendingApprovals) {
        if (p.issueId !== issueId) continue;
        this.pendingApprovals.delete(approvalId);
        p.resolve({ decision: "deny" });
      }
      const task = this.activeTasks.get(issueId);
      if (task) {
        log.info(this.tag, `Cancel requested for ${issueId}, aborting child process`);
        task.aborted = true;
        try { task.controller.abort(); } catch { /* noop */ }
      } else {
        log.info(this.tag, `Cancel requested for ${issueId} but no active task here`);
      }
      // 清理本机 worktree(若该 issue 走了 repo 模式)。issueRepoCtxs 命中即清。
      const repoCtx = this.issueRepoCtxs.get(issueId);
      if (repoCtx) {
        this.cleanupIssueWorktrees(repoCtx.groupId, issueId, repoCtx);
        this.issueRepoCtxs.delete(issueId);
      }
    }

    // Issue interrupt — 对齐 codex CLI 的 ESC:abort 当前 CLI 进程但不翻转
    // issue status(保持 in_progress)。runIssueExecution 的 finally 块会接管:
    //   • pendingAppends[issueId] 非空 → 合并队列 + `--resume <lastSessionId>`
    //     起新一轮(等同于 codex 的 "interrupt + flush queued steers")
    //   • 队列空 → 不重启,issue 留在 idle in_progress,用户下次 append 时
    //     走 issue_append 的 idle 分支用 sessionId resume
    // 与 issue_cancelled 的关键差异:不 resolve pendingApprovals(中断不
    // 终结 issue,审批 gate 状态保留供下一轮继承)、不改 status。
    if (msg.type === "issue_interrupt") {
      const issueId = (msg as any).issueId as string | undefined;
      if (!issueId) return;
      const task = this.activeTasks.get(issueId);
      if (task) {
        log.info(this.tag, `Interrupt requested for ${issueId}, aborting current CLI turn`);
        task.aborted = true;
        // 标记 interrupted 让 finally 块区分 cancel(丢队列)vs interrupt(消费队列续跑)。
        task.interrupted = true;
        try { task.controller.abort(); } catch { /* noop */ }
      } else {
        log.info(this.tag, `Interrupt requested for ${issueId} but no active task here`);
      }
    }

    // Chat reply cancellation — mirror of issue_cancelled for the chat path.
    // activeTasks key is `chat:${requestId}` (set by handleChatReply).
    // No pendingApprovals cleanup needed — chat path doesn't wire approval
    // gating (conversational tool calls stay auto-accepted).
    // No-op when the task already finished naturally (race: user clicked ⏹
    // right as the executor resolved) — log + return.
    if (msg.type === "chat_cancelled") {
      const requestId = (msg as any).requestId as string | undefined;
      if (!requestId) return;
      const taskKey = `chat:${requestId}`;
      const task = this.activeTasks.get(taskKey);
      if (task) {
        log.info(this.tag, `Chat cancel requested for ${requestId}, aborting child process`);
        task.aborted = true;
        try { task.controller.abort(); } catch { /* noop */ }
      } else {
        log.info(this.tag, `Chat cancel for ${requestId} but no active task (already finished?)`);
      }
    }

    // issue_continue 在 handleIssueRepoMsg(async)里处理。

    // Issue append — user typed a follow-up while the issue is still active.
    // (在 handleIssueRepoMsg 里处理)

    // User decided an approval — hand the verdict to the parked codex call.
    if (msg.type === "issue_approval_response") {
      const approvalId = (msg as any).approvalId as string | undefined;
      const decision = (msg as any).decision as "accept" | "deny" | undefined;
      if (!approvalId || (decision !== "accept" && decision !== "deny")) return;
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) {
        log.warn(this.tag, `approval response for unknown id ${approvalId}`);
        return;
      }
      this.pendingApprovals.delete(approvalId);
      if (decision === "accept") {
        pending.resolve({ decision: "accept" });
      } else {
        const feedback = typeof (msg as any).feedback === "string" && (msg as any).feedback
          ? ((msg as any).feedback as string)
          : undefined;
        pending.resolve({ decision: "deny", feedback });
      }
    }

    // Chat message reply
    if (msg.type === "a2a_message") {
      const { requestId, from, payload, conversation, agentProfile, cwd: overrideCwd, repoUrl, repoBranch, extraRepos, worktreeMode } = msg as any;
      if (agentProfile) this.setAgentProfile(agentProfile as AgentProfile);
      const content = payload?.message || "";
      const fromName = from?.name || "unknown";

      // One-on-one: always process
      // Group: only process if @mentioned (qaMode 例外:master 用 --need-reply 触发,
      // 已自动补 @target,但兜底也允许 qaMode 直接绕过 @ 检查)
      const isGroup = conversation?.type === "group";
      const isMentioned = content.includes(`@${this.config.name}`);
      const qaMode = (msg as any).qaMode === true;
      log.info(this.tag, `a2a_message from ${fromName} requestId=${requestId} isGroup=${isGroup} isMentioned=${isMentioned} qaMode=${qaMode} contentLen=${content.length} contentHead=${JSON.stringify(content.slice(0, 60))}`);
      if (repoUrl) {
        log.info(this.tag, `repoCtx: url=${repoUrl} branch=${repoBranch} mode=${worktreeMode} extras=${extraRepos ? JSON.stringify((extraRepos as any[]).map(e => e.id)) : "(none)"}`);
      }
      if (!isGroup || isMentioned || qaMode) {
        log.info(this.tag, `Chat from ${fromName}: ${content.slice(0, 80)}...`);
        this.chat.handleChatReply(requestId, content, fromName, conversation, overrideCwd, { issueId: "chat", repoUrl, repoBranch, extraRepos, worktreeMode });
      } else {
        log.info(this.tag, `SKIP group message from ${fromName}: not @mentioned (looking for @${this.config.name})`);
      }
    }

    // Session management — master asks for visibility / control over the
    // per-(cliTool, groupId) sessions this worker tracks. The list path is
    // covered by the unsolicited `session_snapshot` push (see
    // sendSessionSnapshot above), so workers only handle view / delete here.
    if (msg.type === "session_view_request") {
      const requestId = (msg as any).requestId as string | undefined;
      const groupId = (msg as any).groupId as string | undefined;
      const sessionId = (msg as any).sessionId as string | undefined;
      const tailLines = typeof (msg as any).tailLines === "number" ? (msg as any).tailLines : undefined;
      if (!requestId || !groupId || !sessionId) return;
      void this.handleSessionViewRequest(requestId, groupId, sessionId, tailLines);
      return;
    }

    if (msg.type === "session_delete_request") {
      const requestId = (msg as any).requestId as string | undefined;
      const groupId = (msg as any).groupId as string | undefined;
      const sessionId = (msg as any).sessionId as string | undefined;
      if (!requestId || !groupId || !sessionId) return;
      const had = this.sessions.has(this.cliTool, groupId, sessionId);
      if (had) {
        this.sessions.delete(this.cliTool, groupId);
        log.info(this.tag, `Session deleted via dashboard: ${this.cliTool}:${groupId} → ${sessionId}`);
        // 通知 master 标记失效(不删行,保留历史);再推 snapshot 同步 active 列表。
        this.send({
          type: "session_invalidated",
          cliTool: this.cliTool,
          groupId,
          sessionId,
        });
        this.sendSessionSnapshot();
      }
      this.send({
        type: "session_delete_response",
        requestId,
        groupId,
        sessionId,
        ok: had,
        error: had ? undefined : "session not found in this worker",
      });
      return;
    }
  }

  /**
   * 异步处理 issue_assigned / continue / append。worktree 创建(ensureBareCloneAsync
   * + addWorktreeAsync)用 spawn 而非 spawnSync,避免大仓库 clone 阻塞 executor 其他
   * WS 处理(心跳、chat 取消、其他 issue 进度)。第一次 bare clone 可能几分钟,
   * 用户可见进度事件("📦 正在准备代码仓库...")。
   */
  private async handleIssueRepoMsg(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === "issue_assigned") {
      const { issueId, title, description, groupId, slashCommand, approvalPolicy, agentProfile, cwd: overrideCwd, repoUrl, repoBranch, extraRepos, worktreeMode } = msg as any;
      if (agentProfile) this.setAgentProfile(agentProfile);
      log.info(this.tag, `Issue assigned: "${title}" (${issueId}, group=${groupId ?? "(none)"})${slashCommand ? ` [${slashCommand}]` : ""}${approvalPolicy ? ` [${approvalPolicy}]` : ""}${repoUrl ? ` [repo:${worktreeMode || "group"}]` : ""}`);
      if (repoUrl && groupId && issueId) {
        this.sendUpdate(issueId, "in_progress", "📦 正在准备代码仓库(worktree)...", undefined, overrideCwd);
      }
      const cwd = await this.resolveIssueCwd(groupId, overrideCwd, { issueId, repoUrl, repoBranch, extraRepos, worktreeMode });
      if (repoUrl && issueId) {
        this.issueRepoCtxs.set(issueId, { groupId, repoUrl, extraRepos: (extraRepos as { id: string; url: string; branch?: string; mountPath: string }[] | undefined)?.map((e) => ({ id: e.id, url: e.url })), worktreeMode });
      }
      this.issues.executeIssue(issueId, title, description || "", cwd, slashCommand, approvalPolicy, { issueId, groupId, repoUrl, repoBranch, extraRepos, worktreeMode });
      return;
    }

    if (msg.type === "issue_continue") {
      const issueId = (msg as any).issueId as string | undefined;
      const title = (msg as any).title as string | undefined;
      const prompt = (msg as any).prompt as string | undefined;
      const sessionId = (msg as any).sessionId as string | undefined;
      const groupId = (msg as any).groupId as string | undefined;
      const slashCommand = (msg as any).slashCommand as string | undefined;
      const approvalPolicy = (msg as any).approvalPolicy as "r_allow" | "rw_allow" | undefined;
      const agentProfile = (msg as any).agentProfile as AgentProfile | undefined;
      const overrideCwd = (msg as any).cwd as string | undefined;
      const repoUrl = (msg as any).repoUrl as string | undefined;
      const repoBranch = (msg as any).repoBranch as string | undefined;
      const extraRepos = (msg as any).extraRepos as { id: string; url: string; branch?: string; mountPath: string }[] | undefined;
      const worktreeMode = (msg as any).worktreeMode as string | undefined;
      if (agentProfile) this.setAgentProfile(agentProfile);
      if (!issueId || !prompt) return;
      log.info(this.tag, `Issue continue: "${title ?? "(no title)"}" (${issueId}, session=${sessionId ?? "(none)"}${slashCommand ? `, slash=${slashCommand}` : ""}${approvalPolicy ? `, policy=${approvalPolicy}` : ""}${repoUrl ? `, repo:${worktreeMode || "group"}` : ""})`);
      const cwd = await this.resolveIssueCwd(groupId, overrideCwd, { issueId, repoUrl, repoBranch, extraRepos, worktreeMode });
      const issueHeader =
        `[当前群活跃 issue]\n` +
        `- #${issueId.slice(0, 8)}  in_progress  "${title ?? "(unnamed)"}" by ${this.config.name}\n` +
        `提示：你正在执行此 issue，工作目录 **可写**，直接按任务描述动手即可。` +
        `**不要为此任务再创建新 issue。**\n`;
      const body = `${issueHeader}\n${prompt}`;
      const composed = composePrompt({
        mode: "issue",
        agentName: this.config.name,
        agentProfile: this.agentProfile,
        group: null,
        cwd,
        body,
        approvalPolicy,
      });
      this.issues.runIssueExecution(issueId, composed.final, cwd, sessionId, slashCommand, approvalPolicy, composed, { issueId, groupId, repoUrl, repoBranch, extraRepos, worktreeMode });
      return;
    }

    if (msg.type === "issue_append") {
      const issueId = (msg as any).issueId as string | undefined;
      const title = (msg as any).title as string | undefined;
      const prompt = (msg as any).prompt as string | undefined;
      const sessionId = (msg as any).sessionId as string | undefined;
      const groupId = (msg as any).groupId as string | undefined;
      const slashCommand = (msg as any).slashCommand as string | undefined;
      const approvalPolicy = (msg as any).approvalPolicy as "r_allow" | "rw_allow" | undefined;
      const agentProfile = (msg as any).agentProfile as AgentProfile | undefined;
      const overrideCwd = (msg as any).cwd as string | undefined;
      const repoUrl = (msg as any).repoUrl as string | undefined;
      const repoBranch = (msg as any).repoBranch as string | undefined;
      const extraRepos = (msg as any).extraRepos as { id: string; url: string; branch?: string; mountPath: string }[] | undefined;
      const worktreeMode = (msg as any).worktreeMode as string | undefined;
      if (agentProfile) this.setAgentProfile(agentProfile);
      if (!issueId || !prompt) return;
      const issueHeader =
        `[当前群活跃 issue]\n` +
        `- #${issueId.slice(0, 8)}  in_progress  "${title ?? "(unnamed)"}" by ${this.config.name}\n` +
        `提示：你正在执行此 issue，工作目录 **可写**，直接按任务描述动手即可。` +
        `**不要为此任务再创建新 issue。**\n`;
      const body = `${issueHeader}\n${prompt}`;
      if (this.activeTasks.has(issueId)) {
        const queue = this.pendingAppends.get(issueId) ?? [];
        queue.push(body);
        this.pendingAppends.set(issueId, queue);
        log.info(this.tag, `Issue append queued: ${issueId} (queue=${queue.length})`);
      } else {
        log.info(this.tag, `Issue append (idle, run now): ${issueId} (session=${sessionId ?? "(none)"}${approvalPolicy ? `, policy=${approvalPolicy}` : ""}${repoUrl ? `, repo:${worktreeMode || "group"}` : ""})`);
        const cwd = await this.resolveIssueCwd(groupId, overrideCwd, { issueId, repoUrl, repoBranch, extraRepos, worktreeMode });
        const composed = composePrompt({
          mode: "issue",
          agentName: this.config.name,
          agentProfile: this.agentProfile,
          group: null,
          cwd,
          body,
          approvalPolicy,
        });
        this.issues.runIssueExecution(issueId, composed.final, cwd, sessionId, slashCommand, approvalPolicy, composed, { issueId, groupId, repoUrl, repoBranch, extraRepos, worktreeMode });
      }
    }
  }

  // ── Session helpers ───────────────────────────────────────────────

  /**
   * Push the worker's owned sessions to master as an unsolicited snapshot.
   * Called on auth_ok (initial sync) and after every SessionStore.set/delete
   * so the master's in-memory cache (used by GET /sessions) stays current
   * without dashboards having to broadcast over WS.
   *
   * Filter to entries where the stored cliTool matches `this.cliTool`. The
   * shared `~/.rotom/sessions.json` may carry entries for cliTools this
   * worker doesn't own (e.g. a previous run bound to `claude`); pushing them
   * under the wrong cliTool label would let the dashboard ask this worker
   * for `readSessionContent` on a sessionId it can't find in its own keys,
   * returning "session not found in this worker".
   *
   * Full-array semantics: master REPLACES its cached entry for this worker on
   * receipt. Sending the whole array (typically <10 entries) is cheaper than
   * tracking deltas, and avoids drift on missed messages.
   */
  sendSessionSnapshot(): void {
    const entries = this.sessions
      .listAll()
      .filter((e) => e.cliTool === this.cliTool);
    this.send({ type: "session_snapshot", entries });
  }

  private async handleSessionViewRequest(
    requestId: string,
    groupId: string,
    sessionId: string,
    tailLines?: number,
  ): Promise<void> {
    if (!this.sessions.has(this.cliTool, groupId, sessionId)) {
      this.send({
        type: "session_view_response",
        requestId,
        groupId,
        sessionId,
        format: "raw",
        content: "",
        error: "session not found in this worker",
      });
      return;
    }
    const cwd = await this.resolveIssueCwd(groupId);
    try {
      const result = await this.executor.readSessionContent?.({
        sessionId,
        workingDir: cwd,
        tailLines: tailLines ?? 200,
      });
      if (!result) {
        // Executor doesn't implement introspection for this backend — surface
        // a "not introspectable" empty response rather than 500.
        this.send({
          type: "session_view_response",
          requestId,
          groupId,
          sessionId,
          format: "raw",
          content: "",
          error: `${this.cliTool} backend does not support session introspection`,
        });
        return;
      }
      this.send({
        type: "session_view_response",
        requestId,
        groupId,
        sessionId,
        format: result.format,
        content: result.content,
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (err: any) {
      this.send({
        type: "session_view_response",
        requestId,
        groupId,
        sessionId,
        format: "raw",
        content: "",
        error: err?.message || String(err),
      });
    }
  }

  // ── Sending helpers (shared by all subsystems) ────────────────────

  agentEnv(): Record<string, string> {
    const env: Record<string, string> = {
      ROTOM_AGENT: this.config.name,
      ROTOM_MASTER: this.masterUrl,
    };
    // OPC 本机模式 token 可空,不强制设 ROTOM_TOKEN 让下游 CLI 自己处理。
    if (this.config.token) {
      env.ROTOM_TOKEN = this.config.token;
    }
    return env;
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendUpdate(issueId: string, status: string, content?: string, metadata?: Record<string, unknown>, cwd?: string, composedPrompt?: import("../shared/prompt-composer.js").ComposedPrompt): void {
    const msg: Record<string, unknown> = { type: "issue_update", issueId, status, content, metadata };
    if (cwd) msg.cwd = cwd;
    if (composedPrompt) msg.composedPrompt = composedPrompt;
    this.send(msg);
  }

  /**
   * 执行过程中 executor 上报单轮 token usage 增量。merge 到累积值后做
   * leading+trailing 1s 节流推送:
   *   - leading:距上次推送 ≥ 1000ms 立即推
   *   - trailing:否则排一个 setTimeout 在窗口尾再推一次(只在 dirty 时推,
   *     避免和 leading 重叠推同一份数据)
   *
   * 不调 onUsage 的 backend(codex/hermes/openclaw)→ 本方法不被调,前端
   * 自然降级到终态 issue.usage,无副作用。
   */
  reportIssueUsage(issueId: string, increment: TokenUsage): void {
    let entry = this.usageAccumulators.get(issueId);
    if (!entry) {
      entry = { accumulated: {}, lastPushAt: 0, dirty: false };
      this.usageAccumulators.set(issueId, entry);
    }
    entry.accumulated = mergeTokenUsage(entry.accumulated, increment);
    entry.dirty = true;

    const now = Date.now();
    if (now - entry.lastPushAt >= USAGE_THROTTLE_MS) {
      // leading 窗口已过,直接推
      this.pushAccumulatedUsage(issueId, entry);
      return;
    }
    // 还在节流窗口内,排一个 trailing(若未排)。setTimeout 触发时再 check
    // dirty:可能 leading 已经推过相同值,trailing 无需再推。
    if (!entry.trailingTimer) {
      const wait = USAGE_THROTTLE_MS - (now - entry.lastPushAt);
      entry.trailingTimer = setTimeout(() => {
        const e = this.usageAccumulators.get(issueId);
        if (!e) return;
        e.trailingTimer = undefined;
        if (!e.dirty) return;
        this.pushAccumulatedUsage(issueId, e);
      }, Math.max(0, wait));
      // trailing 不应阻止 Node 退出(虽然 worker 是常驻进程,但语义上对)
      entry.trailingTimer.unref?.();
    }
  }

  /**
   * issue 翻终态时强制 flush 一次累积 usage,确保最后一次推送不丢。
   * override 给定时(通常是 ExecuteResult.usage 终态值)直接覆盖累积值,
   * 保证 reload 后看到的 issue.usage 与最后一次推送口径一致。
   *
   * 必须在 runIssueExecution 的 finally 块调用,覆盖正常完成 / abort / catch
   * 所有路径。flush 后清掉 entry,避免内存泄漏。
   */
  flushIssueUsage(issueId: string, override?: TokenUsage): void {
    const entry = this.usageAccumulators.get(issueId);
    if (!entry) {
      // 整个执行过程 executor 从未调过 onUsage(例如 backend 不支持),
      // 但终态 result.usage 仍有值 → 仍要推一次,让前端拿到终态数字。
      if (override) {
        this.send({ type: "issue_usage_progress", issueId, usage: override });
      }
      return;
    }
    if (entry.trailingTimer) {
      clearTimeout(entry.trailingTimer);
      entry.trailingTimer = undefined;
    }
    if (override) entry.accumulated = override;
    this.pushAccumulatedUsage(issueId, entry);
    this.usageAccumulators.delete(issueId);
  }

  private pushAccumulatedUsage(issueId: string, entry: { accumulated: TokenUsage; lastPushAt: number; dirty: boolean }): void {
    this.send({ type: "issue_usage_progress", issueId, usage: entry.accumulated });
    entry.lastPushAt = Date.now();
    entry.dirty = false;
  }

  sendChatChunk(requestId: string, delta: string): void {
    this.send({ type: "a2a_reply_chunk", requestId, delta });
  }

  sendChatEnd(
    requestId: string,
    fullContent: string,
    conversation: any,
    cwd?: string,
    composedPrompt?: import("../shared/prompt-composer.js").ComposedPrompt,
    options?: { cancelled?: boolean },
  ): void {
    const msg: Record<string, unknown> = {
      type: "a2a_reply_end",
      requestId,
      payload: { message: fullContent },
      conversation,
    };
    if (cwd) msg.cwd = cwd;
    // 中断态不带 composedPrompt —— prompt 已无意义,且 dashboard 端
    // a2a_stream_end 处理对 cancelled 路径会跳过 history 重拉,
    // 传过去也用不上。partial 内容(已积累的 fullContent)是用户唯一关心。
    if (composedPrompt && !options?.cancelled) msg.composedPrompt = composedPrompt;
    if (options?.cancelled) msg.cancelled = true;
    this.send(msg);
  }
}
