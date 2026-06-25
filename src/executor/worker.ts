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
    responsibilities?: string;
    tech_stack?: string;
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
  /** WS socket — assigned by WorkerConnection.connect(). Null until first connect. */
  ws!: WebSocket;
  stopped = false;

  // ── Config-derived readonly fields ────────────────────────────────
  readonly tag: string;
  readonly workingDir: string;
  readonly maxConcurrent: number;
  readonly cliTool: string;
  /** agents.profile 解析后缓存,供 composePrompt() 渲染 agent-role 层。 */
  readonly agentProfile: AgentProfile | null;

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
  resolveIssueCwd(groupId: string | undefined): string {
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
      const { issueId, title, description, groupId, slashCommand, approvalPolicy } = msg as any;
      console.log(`${this.tag} Issue assigned: "${title}" (${issueId}, group=${groupId ?? "(none)"})${slashCommand ? ` [${slashCommand}]` : ""}${approvalPolicy ? ` [${approvalPolicy}]` : ""}`);
      // cwd 按 groupId 派生(<base>/<groupId>),完全本机解析,与 master 无关
      const cwd = this.resolveIssueCwd(groupId);
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
      if (!issueId || !prompt) return;
      console.log(`${this.tag} Issue continue: "${title ?? "(no title)"}" (${issueId}, session=${sessionId ?? "(none)"}${slashCommand ? `, slash=${slashCommand}` : ""}${approvalPolicy ? `, policy=${approvalPolicy}` : ""})`);
      // cwd 按 groupId 派生
      const cwd = this.resolveIssueCwd(groupId);
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
        // cwd 按 groupId 派生
        const cwd = this.resolveIssueCwd(groupId);
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
      const { requestId, from, payload, conversation } = msg as any;
      const content = payload?.message || "";
      const fromName = from?.name || "unknown";

      // One-on-one: always process
      // Group: only process if @mentioned
      const isGroup = conversation?.type === "group";
      const isMentioned = content.includes(`@${this.config.name}`);
      if (!isGroup || isMentioned) {
        console.log(`${this.tag} Chat from ${fromName}: ${content.slice(0, 80)}...`);
        this.chat.handleChatReply(requestId, content, fromName, conversation);
      }
    }

    // Collaboration started notification
    if (msg.type === "collaboration_started") {
      const { issueId, title, collaborationGoal, participants, maxRounds, round, groupId } = msg as any;
      console.log(`${this.tag} Collaboration started: "${title}" round=${round}/${maxRounds}`);
      // cwd 按 groupId 派生
      this.chat.handleCollaborationStarted(issueId, title, collaborationGoal, participants, round, maxRounds, groupId);
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
