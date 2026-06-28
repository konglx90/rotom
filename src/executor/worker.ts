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

// ── Config ──────────────────────────────────────────────────────────────

export interface WorkerConfig {
  /** Agent 名称 */
  name: string;
  /** 认证 token */
  token: string;
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
  // activeTasks key shape: issueId | `chat:${requestId}` | `collab-${issueId}`
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
   *  WS 消息(issue_assigned/continue/append、a2a_message、collaboration_started)
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
  ) {
    this.tag = `[executor:${config.name}]`;
    // workingDir 是 per-group cwd 派生的 base,完全本机解析,与 master 无关。
    // index.ts 启动时已校验存在 / 可读;此处仅做兜底默认值。
    if (!config.workingDir) {
      console.warn(`${this.tag} WARN: no workingDir configured, falling back to ~/.rotom (likely not a project dir, agent may have nothing to read)`);
    }
    this.workingDir = config.workingDir || path.join(os.homedir(), ".rotom");
    this.maxConcurrent = config.maxConcurrent ?? 2;
    this.cliTool = cliTool;
    this.sessions = new SessionStore(this.rotomHome);
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
  resolveIssueCwd(groupId: string | undefined, override?: string): string {
    // 0. master 推送的 cwd(Dashboard 配置的群工作目录)优先 —— 跨机器部署时
    //    若本机不存在该路径则静默回落本地派生,保证 worker 永远能 spawn。
    if (override && fs.existsSync(override)) {
      fs.mkdirSync(override, { recursive: true });
      return override;
    }
    // 1. per-group override
    if (groupId && this.config.workingDirMap?.[groupId]) {
      const mapped = this.config.workingDirMap[groupId];
      fs.mkdirSync(mapped, { recursive: true });
      return mapped;
    }
    // 2. 按 groupId 派生
    if (groupId) {
      const derived = path.join(this.workingDir, groupId);
      fs.mkdirSync(derived, { recursive: true });
      return derived;
    }
    // 3. 兜底
    return this.workingDir;
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
    console.log(`${this.tag} agentProfile updated (${sig})`);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start(): void {
    this.connection.start();
  }

  stop(): void {
    this.connection.stop();
    // Flush pending SessionStore writes — without this, sessions sitting in
    // the 1s debounce timer would be lost on SIGINT/shutdown.
    this.sessions.shutdown();
  }

  // ── Message router ────────────────────────────────────────────────

  handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "auth_ok") {
      console.log(`${this.tag} Authenticated`);
      // Push initial SessionStore snapshot so master's cache is populated
      // before any dashboard hits GET /sessions. Master replaces any prior
      // snapshot for this worker on receipt.
      this.sendSessionSnapshot();
      this.connection.startHeartbeat();
    }

    if (msg.type === "auth_fail") {
      console.error(`${this.tag} Auth failed: ${msg.reason}`);
      return;
    }

    // Issue assignment
    if (msg.type === "issue_assigned") {
      const { issueId, title, description, groupId, slashCommand, approvalPolicy, agentProfile, cwd: overrideCwd } = msg as any;
      if (agentProfile) this.setAgentProfile(agentProfile);
      console.log(`${this.tag} Issue assigned: "${title}" (${issueId}, group=${groupId ?? "(none)"})${slashCommand ? ` [${slashCommand}]` : ""}${approvalPolicy ? ` [${approvalPolicy}]` : ""}`);
      // cwd 优先用 master 推送(Dashboard 群工作目录);本机不存在则回落派生
      const cwd = this.resolveIssueCwd(groupId, overrideCwd);
      this.issues.executeIssue(issueId, title, description || "", cwd, slashCommand, approvalPolicy);
    }

    if (msg.type === "issue_created") {
      console.log(`${this.tag} New issue: "${(msg as any).title}" (awaiting manual assignment)`);
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
        console.log(`${this.tag} Cancel requested for ${issueId}, aborting child process`);
        task.aborted = true;
        try { task.controller.abort(); } catch { /* noop */ }
      } else {
        console.log(`${this.tag} Cancel requested for ${issueId} but no active task here`);
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
        console.log(`${this.tag} Interrupt requested for ${issueId}, aborting current CLI turn`);
        task.aborted = true;
        // 标记 interrupted 让 finally 块区分 cancel(丢队列)vs interrupt(消费队列续跑)。
        task.interrupted = true;
        try { task.controller.abort(); } catch { /* noop */ }
      } else {
        console.log(`${this.tag} Interrupt requested for ${issueId} but no active task here`);
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
        console.log(`${this.tag} Chat cancel requested for ${requestId}, aborting child process`);
        task.aborted = true;
        try { task.controller.abort(); } catch { /* noop */ }
      } else {
        console.log(`${this.tag} Chat cancel for ${requestId} but no active task (already finished?)`);
      }
    }

    // Issue continuation — user appended a follow-up prompt on a completed
    // /failed issue; re-spawn the CLI with --resume <sessionId>.
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
      if (agentProfile) this.setAgentProfile(agentProfile);
      if (!issueId || !prompt) return;
      console.log(`${this.tag} Issue continue: "${title ?? "(no title)"}" (${issueId}, session=${sessionId ?? "(none)"}${slashCommand ? `, slash=${slashCommand}` : ""}${approvalPolicy ? `, policy=${approvalPolicy}` : ""})`);
      // cwd 优先用 master 推送;本机不存在则回落派生
      const cwd = this.resolveIssueCwd(groupId, overrideCwd);
      const issueHeader =
        `[当前群活跃 issue]
` +
        `- #${issueId.slice(0, 8)}  in_progress  "${title ?? "(unnamed)"}" by ${this.config.name}
` +
        `提示：你正在执行此 issue，工作目录 **可写**，直接按任务描述动手即可。` +
        `**不要为此任务再创建新 issue。**
`;
      const body = `${issueHeader}
${prompt}`;
      const composed = composePrompt({
        mode: "issue",
        agentName: this.config.name,
        agentProfile: this.agentProfile,
        group: null,
        cwd,
        body,
        approvalPolicy,
      });
      this.issues.runIssueExecution(issueId, composed.final, cwd, sessionId, slashCommand, approvalPolicy, composed);
    }

    // Issue append — user typed a follow-up while the issue is still active.
    // If a task is running we queue; runIssueExecution's finally block will
    // pick it up after the current CLI call returns and spawn a new run with
    // --resume. If no task is running (issue idle in open/in_progress for
    // whatever reason) we start one immediately, mirroring issue_continue.
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
      if (agentProfile) this.setAgentProfile(agentProfile);
      if (!issueId || !prompt) return;
      const issueHeader =
        `[当前群活跃 issue]
` +
        `- #${issueId.slice(0, 8)}  in_progress  "${title ?? "(unnamed)"}" by ${this.config.name}
` +
        `提示：你正在执行此 issue，工作目录 **可写**，直接按任务描述动手即可。` +
        `**不要为此任务再创建新 issue。**
`;
      const body = `${issueHeader}
${prompt}`;
      if (this.activeTasks.has(issueId)) {
        const queue = this.pendingAppends.get(issueId) ?? [];
        queue.push(body);
        this.pendingAppends.set(issueId, queue);
        console.log(`${this.tag} Issue append queued: ${issueId} (queue=${queue.length})`);
      } else {
        console.log(`${this.tag} Issue append (idle, run now): ${issueId} (session=${sessionId ?? "(none)"}${approvalPolicy ? `, policy=${approvalPolicy}` : ""})`);
        // cwd 优先用 master 推送;本机不存在则回落派生
        const cwd = this.resolveIssueCwd(groupId, overrideCwd);
        const composed = composePrompt({
          mode: "issue",
          agentName: this.config.name,
          agentProfile: this.agentProfile,
          group: null,
          cwd,
          body,
          approvalPolicy,
        });
        this.issues.runIssueExecution(issueId, composed.final, cwd, sessionId, slashCommand, approvalPolicy, composed);
      }
    }

    // User decided an approval — hand the verdict to the parked codex call.
    if (msg.type === "issue_approval_response") {
      const approvalId = (msg as any).approvalId as string | undefined;
      const decision = (msg as any).decision as "accept" | "deny" | undefined;
      if (!approvalId || (decision !== "accept" && decision !== "deny")) return;
      const pending = this.pendingApprovals.get(approvalId);
      if (!pending) {
        console.warn(`${this.tag} approval response for unknown id ${approvalId}`);
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
      const { requestId, from, payload, conversation, agentProfile, cwd: overrideCwd } = msg as any;
      if (agentProfile) this.setAgentProfile(agentProfile as AgentProfile);
      const content = payload?.message || "";
      const fromName = from?.name || "unknown";

      // One-on-one: always process
      // Group: only process if @mentioned
      const isGroup = conversation?.type === "group";
      const isMentioned = content.includes(`@${this.config.name}`);
      console.log(`${this.tag} a2a_message from ${fromName} requestId=${requestId} isGroup=${isGroup} isMentioned=${isMentioned} contentLen=${content.length} contentHead=${JSON.stringify(content.slice(0, 60))}`);
      if (!isGroup || isMentioned) {
        console.log(`${this.tag} Chat from ${fromName}: ${content.slice(0, 80)}...`);
        this.chat.handleChatReply(requestId, content, fromName, conversation, overrideCwd);
      } else {
        console.log(`${this.tag} SKIP group message from ${fromName}: not @mentioned (looking for @${this.config.name})`);
      }
    }

    // Collaboration started notification
    if (msg.type === "collaboration_started") {
      const { issueId, title, collaborationGoal, participants, maxRounds, round, groupId, agentProfile, cwd: overrideCwd } = msg as any;
      if (agentProfile) this.setAgentProfile(agentProfile as AgentProfile);
      console.log(`${this.tag} Collaboration started: "${title}" round=${round}/${maxRounds}`);
      this.chat.handleCollaborationStarted(issueId, title, collaborationGoal, participants, round, maxRounds, groupId, overrideCwd);
    }

    // Collaboration concluded notification
    if (msg.type === "collaboration_concluded") {
      const { title, summary } = msg as any;
      console.log(`${this.tag} Collaboration concluded: ${title}`);
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
        console.log(`${this.tag} Session deleted via dashboard: ${this.cliTool}:${groupId} → ${sessionId}`);
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
    const cwd = this.resolveIssueCwd(groupId);
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
    return {
      ROTOM_AGENT: this.config.name,
      ROTOM_MASTER: this.masterUrl,
      ROTOM_TOKEN: this.config.token,
    };
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
