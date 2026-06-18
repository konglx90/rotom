/**
 * ExecutorWorker — 单个数字员工的完整生命周期
 *
 * 每个 worker 拥有独立的 WebSocket 连接、身份、CLI 后端和任务队列。
 * 职责：Issue 执行 + 群聊回复。
 */

import { WebSocket } from "ws";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequestInput, CliExecutor } from "./cli-executor.js";
import { composePrompt, type ComposedPrompt } from "../shared/prompt-composer.js";
import { parseAgentProfile, type AgentProfile } from "../shared/agent-profile.js";
import { parseSlashCommand } from "../shared/slash-commands.js";

// ── Session store ──────────────────────────────────────────────────────

/**
 * Manages conversation sessions per group per CLI.
 * Persisted to ~/.rotom/sessions.json so sessions survive restarts.
 * Key format: `${cliTool}:${groupId}` → sessionId
 */
class SessionStore {
  private sessions = new Map<string, string>();
  private filePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rotomDir: string) {
    this.filePath = path.join(rotomDir, "sessions.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Record<string, string>;
        for (const [k, v] of Object.entries(data)) {
          this.sessions.set(k, v);
        }
        console.log(`[session-store] Loaded ${this.sessions.size} session(s) from ${this.filePath}`);
      }
    } catch (err: any) {
      console.warn(`[session-store] Failed to load: ${err.message}`);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1000);
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.sessions) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
      this.dirty = false;
    } catch (err: any) {
      console.warn(`[session-store] Failed to flush: ${err.message}`);
    }
  }

  private key(cliTool: string, groupId: string): string {
    return `${cliTool}:${groupId}`;
  }

  get(cliTool: string, groupId: string): string | undefined {
    return this.sessions.get(this.key(cliTool, groupId));
  }

  set(cliTool: string, groupId: string, sessionId: string): void {
    this.sessions.set(this.key(cliTool, groupId), sessionId);
    this.dirty = true;
    this.scheduleFlush();
  }

  delete(cliTool: string, groupId: string): void {
    this.sessions.delete(this.key(cliTool, groupId));
    this.dirty = true;
    this.scheduleFlush();
  }

  has(cliTool: string, groupId: string, sessionId: string): boolean {
    return this.sessions.get(this.key(cliTool, groupId)) === sessionId;
  }

  /**
   * Return every entry in the store, parsed from the `${cliTool}:${groupId}`
   * keys. Used by the worker's session_snapshot push so master can cache the
   * full picture without per-group requests.
   */
  listAll(): Array<{ cliTool: string; groupId: string; sessionId: string }> {
    const out: Array<{ cliTool: string; groupId: string; sessionId: string }> = [];
    for (const [k, sessionId] of this.sessions) {
      const sep = k.indexOf(":");
      if (sep === -1) continue;
      out.push({ cliTool: k.slice(0, sep), groupId: k.slice(sep + 1), sessionId });
    }
    return out;
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}

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
  private ws!: WebSocket;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeTasks = new Map<string, { aborted: boolean; interrupted?: boolean; controller: AbortController }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private sessionStore!: SessionStore;
  /**
   * Approvals awaiting the user's Accept/Deny. Keyed by approvalId (the same
   * id sent to Master and rendered in the dashboard). Issue cancel resolves
   * every entry for that issue to "deny" so codex can unblock and exit.
   */
  private pendingApprovals = new Map<string, {
    issueId: string;
    resolve: (decision: ApprovalDecision) => void;
  }>();

  // 已入队但尚未消费的「追加指令」。user 在 in_progress 期间提交的 prompt
  // 先攒在这里,当前一轮 CLI 收尾时(runIssueExecution 的 finally)合并起一轮新执行。
  private pendingAppends = new Map<string, string[]>();

  private readonly tag: string;
  private readonly workingDir: string;
  private readonly maxConcurrent: number;
  private readonly cliTool: string;
  /** agents.profile 解析后缓存,供 composePrompt() 渲染 agent-role 层。 */
  private readonly agentProfile: AgentProfile | null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly executor: CliExecutor,
    private readonly masterUrl: string,
    cliTool: string,
    /**
     * Rotom 主目录(通常 `~/.rotom`)。SessionStore 文件落在该目录下
     * (`<rotomHome>/sessions.json`),与 per-group cwd 派生路径**解耦**——
     * session 是 worker 全局状态,不应该跟着 groupId 散布到 `<base>/<groupId>/` 里。
     */
    private readonly rotomHome: string,
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
    this.sessionStore = new SessionStore(this.rotomHome);
    this.agentProfile = parseAgentProfile(JSON.stringify(config.profile ?? null));

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
  private resolveIssueCwd(groupId: string | undefined): string {
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

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close(1000, "shutdown");
  }

  // ── Connection ────────────────────────────────────────────────────────

  private wsUrl(): string {
    let url = this.masterUrl;
    if (!url.endsWith("/ws")) url += "/ws";
    return url;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.wsUrl();
    const cliName = this.config.cliTool || "auto";
    console.log(`${this.tag} Connecting to ${url} (cli: ${cliName}, cwd: ${this.workingDir})`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.ws.send(JSON.stringify({
        type: "auth",
        name: this.config.name,
        token: this.config.token,
        version: 2,
        profile: this.config.profile || {},
        cliTool: this.cliTool,
        instance: {
          instanceId: `${os.hostname()}-${process.pid}-${randomUUID()}`,
          hostname: os.hostname(),
          platform: `${process.platform} ${process.arch}`,
          endpoint: this.masterUrl,
        },
      }));
    });

    this.ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.handleMessage(msg);
    });

    this.ws.on("close", () => {
      console.log(`${this.tag} Disconnected, reconnecting in 3s...`);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
      }
    });

    this.ws.on("error", (err) => {
      console.error(`${this.tag} WS error:`, err.message);
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "auth_ok") {
      console.log(`${this.tag} Authenticated`);
      // Push initial SessionStore snapshot so master's cache is populated
      // before any dashboard hits GET /sessions. Master replaces any prior
      // snapshot for this worker on receipt.
      this.sendSessionSnapshot();
      this.heartbeatTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, 10_000);
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
      this.executeIssue(issueId, title, description || "", cwd, slashCommand, approvalPolicy);
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
    // activeTasks key is `chat:${requestId}` (set by handleChatReply at L852).
    // No pendingApprovals cleanup needed — chat path doesn't wire approval
    // gating (worker.ts:893 note: conversational tool calls stay auto-accepted).
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
      const prompt = (msg as any).prompt as string | undefined;
      const sessionId = (msg as any).sessionId as string | undefined;
      const groupId = (msg as any).groupId as string | undefined;
      const slashCommand = (msg as any).slashCommand as string | undefined;
      const approvalPolicy = (msg as any).approvalPolicy as "r_allow" | "rw_allow" | undefined;
      if (!issueId || !prompt) return;
      console.log(`${this.tag} Issue continue: ${issueId} (session=${sessionId ?? "(none)"}${slashCommand ? `, slash=${slashCommand}` : ""}${approvalPolicy ? `, policy=${approvalPolicy}` : ""})`);
      // cwd 按 groupId 派生
      const cwd = this.resolveIssueCwd(groupId);
      const composed = composePrompt({
        mode: "issue",
        agentName: this.config.name,
        agentProfile: this.agentProfile,
        group: null,
        cwd,
        body: prompt,
      });
      this.runIssueExecution(issueId, composed.final, cwd, sessionId, slashCommand, approvalPolicy, composed);
    }

    // Issue append — user typed a follow-up while the issue is still active.
    // If a task is running we queue; runIssueExecution's finally block will
    // pick it up after the current CLI call returns and spawn a new run with
    // --resume. If no task is running (issue idle in open/in_progress for
    // whatever reason) we start one immediately, mirroring issue_continue.
    if (msg.type === "issue_append") {
      const issueId = (msg as any).issueId as string | undefined;
      const prompt = (msg as any).prompt as string | undefined;
      const sessionId = (msg as any).sessionId as string | undefined;
      const groupId = (msg as any).groupId as string | undefined;
      const slashCommand = (msg as any).slashCommand as string | undefined;
      const approvalPolicy = (msg as any).approvalPolicy as "r_allow" | "rw_allow" | undefined;
      if (!issueId || !prompt) return;
      if (this.activeTasks.has(issueId)) {
        const queue = this.pendingAppends.get(issueId) ?? [];
        queue.push(prompt);
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
          body: prompt,
        });
        this.runIssueExecution(issueId, composed.final, cwd, sessionId, slashCommand, approvalPolicy, composed);
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
        this.handleChatReply(requestId, content, fromName, conversation);
      }
    }

    // Collaboration started notification
    if (msg.type === "collaboration_started") {
      const { issueId, title, collaborationGoal, participants, maxRounds, round, groupId } = msg as any;
      console.log(`${this.tag} Collaboration started: "${title}" round=${round}/${maxRounds}`);
      // cwd 按 groupId 派生
      this.handleCollaborationStarted(issueId, title, collaborationGoal, participants, round, maxRounds, groupId);
    }

    // Collaboration concluded notification
    if (msg.type === "collaboration_concluded") {
      const { title, summary } = msg as any;
      console.log(`${this.tag} Collaboration concluded: "${title}"`);
    }

    // Session management — master asks for visibility / control over the
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
      const had = this.sessionStore.has(this.cliTool, groupId, sessionId);
      if (had) {
        this.sessionStore.delete(this.cliTool, groupId);
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
  private sendSessionSnapshot(): void {
    const entries = this.sessionStore
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
    if (!this.sessionStore.has(this.cliTool, groupId, sessionId)) {
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

  // ── Sending helpers ───────────────────────────────────────────────────

  private agentEnv(): Record<string, string> {
    return {
      ROTOM_AGENT: this.config.name,
      ROTOM_MASTER: this.masterUrl,
      ROTOM_TOKEN: this.config.token,
    };
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendUpdate(issueId: string, status: string, content?: string, metadata?: Record<string, unknown>, cwd?: string, composedPrompt?: ComposedPrompt): void {
    const msg: Record<string, unknown> = { type: "issue_update", issueId, status, content, metadata };
    if (cwd) msg.cwd = cwd;
    if (composedPrompt) msg.composedPrompt = composedPrompt;
    this.send(msg);
  }

  private sendChatChunk(requestId: string, delta: string): void {
    this.send({ type: "a2a_reply_chunk", requestId, delta });
  }

  private sendChatEnd(
    requestId: string,
    fullContent: string,
    conversation: any,
    cwd?: string,
    composedPrompt?: ComposedPrompt,
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

  // ── Issue claiming ────────────────────────────────────────────────────

  private async tryClaimNextIssue(): Promise<void> {
    try {
      const baseUrl = this.masterUrl
        .replace("ws://", "http://")
        .replace("wss://", "https://")
        .replace(/\/ws$/, "") + "/api";
      const resp = await fetch(`${baseUrl}/issues/claim-next`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ agentName: this.config.name }),
      });
      console.log(`${this.tag} Claim response: ${resp.status}`, this.config.token, this.config.name, this.masterUrl);
      if (resp.ok) {
        const issue = await resp.json() as Record<string, unknown> | null;
        if (issue && typeof issue.id === "string") {
          console.log(`${this.tag} Claimed: "${issue.title}" (${issue.id})`);
          // cwd 按 groupId 派生(<base>/<groupId>),完全本机解析,与 master 无关
          const cwd = this.resolveIssueCwd(issue.group_id as string | undefined);
          this.executeIssue(
            issue.id as string,
            issue.title as string,
            (issue.description as string) || "",
            cwd,
          );
        }
      } else {
        console.error(`${this.tag} Claim failed: ${resp.status}`);
      }
    } catch (err: any) {
      console.error(`${this.tag} Claim error:`, err.message);
    }
  }

  // ── Issue execution ───────────────────────────────────────────────────

  private async executeIssue(issueId: string, title: string, description: string, cwd: string, slashCommand?: string, approvalPolicy?: "r_allow" | "rw_allow"): Promise<void> {
    // 若 title 带已注册的 slash 前缀，剥掉字面量再喂给 CLI——避免在非交互模式
    // 下被模型按文本理解。master 端已经识别并下发了 slashCommand，这里做双保险。
    let cleanTitle = title;
    if (slashCommand) {
      const parsed = parseSlashCommand(title);
      if (parsed?.known && parsed.command === slashCommand) {
        cleanTitle = parsed.stripped || title;
      }
    }
    const body = description ? `${cleanTitle}\n\n${description}` : cleanTitle;
    // issue 模式没有 conversation(group_basic 层无法渲染,因为 worker 这边没有
    // activeIssues 数据);只拼 rotom-cli + agent-role + cwd + task 四层。
    const composed = composePrompt({
      mode: "issue",
      agentName: this.config.name,
      agentProfile: this.agentProfile,
      group: null,
      cwd,
      body,
    });
    this.runIssueExecution(issueId, composed.final, cwd, undefined, slashCommand, approvalPolicy, composed);
  }

  /**
   * Core issue execution loop — shared by first-run (executeIssue) and
   * continuation (handleIssueContinue). When resumeSessionId is provided the
   * CLI gets --resume / thread/resume so the conversation picks up where it
   * left off.
   */
  private async runIssueExecution(issueId: string, prompt: string, cwd: string, resumeSessionId?: string, slashCommand?: string, approvalPolicy?: "r_allow" | "rw_allow", composedPrompt?: ComposedPrompt): Promise<void> {
    if (this.activeTasks.size >= this.maxConcurrent) {
      console.log(`${this.tag} At capacity (${this.maxConcurrent}), skip ${issueId}`);
      return;
    }
    if (this.activeTasks.has(issueId)) return;

    const controller = new AbortController();
    const task: { aborted: boolean; interrupted?: boolean; controller: AbortController } = { aborted: false, controller };
    this.activeTasks.set(issueId, task);

    const cliName = this.config.cliTool || "cli";
    this.sendUpdate(issueId, "in_progress", `${resumeSessionId ? "Resuming" : "Starting"} with ${cliName}...`, undefined, cwd);

    // 本轮结束后用于喂给 append 续跑的 sessionId — 优先用本轮新产出的,
    // fall back 到入参 resumeSessionId(本轮没拿到新 session 时,比如 codex 早退)。
    let lastSessionId: string | undefined = resumeSessionId;

    // issue / collab 执行流程强制 rw_allow:本次执行期间工作目录直接可写,
    // agent 调 Write/Edit/MultiEdit/写 Bash 会立即放行,不挂 dashboard 审批
    // (prompt-composer 的 cwd 层已告诉 agent 同样的语义)。chat 模式根本
    // 不会进 runIssueExecution,这里不需要为它分支。
    // 入参 approvalPolicy 字段保留在 schema 上,主要是为了未来 dashboard 提供
    // "手动严格审批"开关时复用;当前所有执行路径统一走 rw_allow。
    const effectivePolicy: "r_allow" | "rw_allow" = "rw_allow";
    // PreToolUse hook 始终挂载:避免 claude 自己的权限提示因 stdin 关闭而卡死。
    // 由于 effectivePolicy 永远是 rw_allow,所有调用立即 auto-accept,Dashboard
    // 仍能看到 issue_approval_request 可见性记录但不阻塞用户。
    const onApprovalRequest = (req: ApprovalRequestInput) => {
      const approvalId = randomUUID();
      if (effectivePolicy === "rw_allow") {
        // rw_allow:立即放行,本地 decision=accept。不发 issue_approval_request
        // 给 master —— 否则 Dashboard 会渲染成"待确认"卡片,误导用户以为
        // agent 被阻塞,实际底层 claude 已经继续跑。审计/可见性可从 master
        // 日志 + claude session jsonl 拉(都是 fullOutput 的一部分)。
        return Promise.resolve({ decision: "accept" } satisfies ApprovalDecision);
      }
      // r_allow:Dashboard 侧能看到请求记录,挂起等待用户 Accept/Deny
      this.send({
        type: "issue_approval_request",
        issueId,
        approvalId,
        kind: req.kind,
        summary: req.summary,
        command: req.command,
        cwd: req.cwd,
        files: req.files,
        plan: req.plan,
        diff: req.diff,
        questions: req.questions,
      });
      return new Promise<ApprovalDecision>((resolve) => {
        this.pendingApprovals.set(approvalId, { issueId, resolve });
      });
    };

    try {
      const result = await this.executor.execute(prompt, cwd, (chunk) => {
        if (task.aborted) return;
        this.sendUpdate(issueId, "in_progress", chunk, undefined, cwd);
      }, {
        signal: controller.signal,
        env: this.agentEnv(),
        kind: "issue",
        sessionId: resumeSessionId,
        slashCommand,
        approvalPolicy: effectivePolicy,
        onApprovalRequest,
      });

      // 不管后续走 abort / completed / failed 哪条分支,先把本轮 sessionId
      // 抓回来 —— finally 的队列续跑要用它做 --resume,丢了就起新会话丢上下文。
      // 之前的 bug:interrupt 走 `if (task.aborted) return` 早返回,这行被跳过,
      // 队列续跑 lastSessionId=undefined → claude 起新会话,前一轮工作全丢。
      if (result?.sessionId) lastSessionId = result.sessionId;

      if (task.aborted) {
        // 中断/取消事件已由 /interrupt 或 /cancel API 在落 issue_event 的同时
        // 推 WS 给 worker,worker 不再二次 sendUpdate —— 否则 master 会再落一条
        // progress 事件,把 "[interrupted] 当前步骤已中断..." 这种系统话塞进
        // agent 的对话气泡(被 groupEvents 当成 mergeable progress 合并)。
        // sessionId 已在上面抓回,finally 块会用它做 --resume 续跑队列。
        return;
      }

      const artifacts = this.extractArtifacts(result.fullOutput);

      // Persist sessionId + cliTool so the master can feed them back for
      // continuation (POST /issues/:id/continue → issue_continue WS).
      const sessionMeta: Record<string, unknown> = { artifacts };
      if (result.sessionId) {
        sessionMeta.sessionId = result.sessionId;
      } else if (resumeSessionId) {
        // Resume was requested but executor returned no session (e.g. claude
        // "No conversation found"). Clear the stale session_id in DB so the
        // next continuation starts fresh instead of retrying the dead session.
        sessionMeta.sessionId = null;
      }
      sessionMeta.cliTool = this.cliTool;

      if (result.exitCode === 0) {
        this.sendUpdate(issueId, "completed", result.fullOutput, sessionMeta, cwd, composedPrompt);
        console.log(`${this.tag} Issue done: ${issueId} (exit=0, session=${result.sessionId ?? "none"})`);
      } else {
        this.sendUpdate(issueId, "failed", `Exit ${result.exitCode}\n${result.fullOutput}`, sessionMeta, cwd, composedPrompt);
        console.log(`${this.tag} Issue failed: ${issueId} (exit=${result.exitCode})`);
      }
    } catch (err: any) {
      if (task.aborted) {
        // 走异常路径的中断/取消(理论上 executor 都走 resolve,catch 是兜底)。
        // 同 try 块,事件已由 API 落库,worker 不再二次 sendUpdate。
        console.log(`${this.tag} Issue aborted via exception: ${issueId} (interrupted=${!!task.interrupted})`);
      } else {
        this.sendUpdate(issueId, "failed", err.message, undefined, cwd);
        console.error(`${this.tag} Issue error: ${issueId}`, err.message);
      }
    } finally {
      this.activeTasks.delete(issueId);
      for (const [approvalId, p] of this.pendingApprovals) {
        if (p.issueId !== issueId) continue;
        this.pendingApprovals.delete(approvalId);
        p.resolve({ decision: "deny" });
      }
      // 取消的任务丢弃排队 append(用户主动放弃,不该再触发续跑);
      // 正常 / 失败 / 中断才消费队列起新一轮。中断(interrupted)与取消的
      // 区别:中断保留 session 并消费队列(对齐 codex ESC + flush steers),
      // 取消则整体作废。
      const queued = this.pendingAppends.get(issueId);
      this.pendingAppends.delete(issueId);
      const shouldConsumeQueue = !task.aborted || !!task.interrupted;
      if (queued && queued.length > 0 && shouldConsumeQueue) {
        const merged = queued.join("\n\n");
        console.log(`${this.tag} Issue append consuming queue: ${issueId} (count=${queued.length}, session=${lastSessionId ?? "(none)"}, interrupted=${!!task.interrupted})`);
        // setImmediate 避免在 finally 同步链上递归调起新一轮。
        // 队列消费继承本轮的 effectivePolicy；append 自己的 ws 消息此时已经在
        // 队列里被吃掉，没机会再传策略，沿用本轮是正确做法（用户切换策略后
        // 新的 issue_append 会重新走 ws → effectivePolicy 才会刷新）。
        setImmediate(() => {
          this.runIssueExecution(issueId, merged, cwd, lastSessionId, slashCommand, effectivePolicy);
        });
      }
    }
  }

  // ── Chat reply ────────────────────────────────────────────────────────

  private async handleChatReply(requestId: string, content: string, fromName: string, conversation: any): Promise<void> {
    const taskKey = `chat:${requestId}`;
    if (this.activeTasks.has(taskKey)) return;

    const groupId: string = conversation?.id ?? conversation?.groupId ?? "";
    // cwd 走本机派生:<workingDirMap[groupId]> 或 <base>/<groupId>。
    // 故意忽略 conversation.workingDir —— 那是 master DB 里存的绝对路径,
    // 多机部署下推到非 master executor 时目录不存在,会导致 spawn 失败。
    // 详见 resolveIssueCwd 上方"跨机器部署安全"注释。
    const resolveChatCwd = (): string => this.resolveIssueCwd(groupId || undefined);

    if (this.activeTasks.size >= this.maxConcurrent) {
      this.sendChatEnd(requestId, `[系统] 当前任务繁忙，请稍后再试`, conversation, resolveChatCwd());
      return;
    }

    const controller = new AbortController();
    const task = { aborted: false, controller };
    this.activeTasks.set(taskKey, task);

    const body = content.replace(`@${this.config.name}`, "").trim();

    if (!body) {
      this.activeTasks.delete(taskKey);
      this.sendChatEnd(requestId, "你好，有什么可以帮你的？", conversation, resolveChatCwd());
      return;
    }

    // Resolve session for this group
    const sessionId = groupId ? this.sessionStore.get(this.cliTool, groupId) : undefined;

    const cwd = resolveChatCwd();

    // 拼 prompt:rotom-cli → agent-role → group-basic → cwd → task。
    // group 信息从 conversation 抽出(master 已 enrich 过 activeIssues / groupName)。
    // fromName 告诉 agent 这条消息是谁发的,避免 agent 不知道对话方身份。
    const composed = composePrompt({
      mode: "chat",
      agentName: this.config.name,
      agentProfile: this.agentProfile,
      group: conversation?.groupId
        ? {
            id: conversation.groupId,
            name: conversation.groupName || conversation.groupId,
            activeIssues: conversation.activeIssues ?? [],
          }
        : null,
      cwd,
      fromName: fromName || null,
      body,
    });

    console.log(`${this.tag} Session lookup: cliTool=${this.cliTool}, groupId=${groupId}, sessionId=${sessionId ?? "(none)"}, conversation=${JSON.stringify(conversation)}`);
    console.log(`${this.tag} Replying to ${fromName}: ${composed.final.slice(0, 60)}...`);

    // 提到 try 块外:catch 路径下(子进程被 SIGTERM 后某些 executor 会 throw)
    // 仍要拿着已积累的 partial content 走 cancelled 终态,否则传空字符串给
    // master 会把前端已经看到的流式内容覆盖成空。
    let fullContent = "";
    try {
      // Chat replies (DM + @-mention in groups) intentionally do NOT pass
      // onApprovalRequest. Rationale:
      //   • Conversational tool calls should feel snappy — pausing for a
      //     human Accept/Deny breaks the chat UX.
      //   • Codex chat sessions are resumed by sessionId; a denied tool call
      //     leaves an "assistant tool_calls without matching tool message"
      //     hole in the conversation history, which makes the NEXT chat turn
      //     fail with `invalid_request_error: An assistant message with
      //     'tool_calls' must be followed by tool messages…`.
      // File writes here still need a backing in-progress issue (the prompt
      // tells the agent so — see composePrompt group-basic active_issues block).
      const execOptions: Parameters<typeof this.executor.execute>[3] = {
        signal: controller.signal,
        env: this.agentEnv(),
        kind: "chat",
        // 2-minute hard wall-clock cap on chat replies. Without this a
        // hanging openclaw subprocess can tie up the worker's
        // activeTasks slot until the user gives up and the daemon
        // restarts. Executors pass this through to `--timeout` AND set
        // a defensive SIGKILL after a small grace.
        timeoutMs: 120_000,
      };
      if (sessionId) execOptions.sessionId = sessionId;
      // cwd 按 groupId 派生
      const result = await this.executor.execute(composed.final, cwd, (chunk) => {
        if (task.aborted) return;
        fullContent += chunk;
        this.sendChatChunk(requestId, chunk);
      }, execOptions);

      // Drop the cached sessionId if the executor reports the conversation
      // history is poisoned (e.g. dangling tool_calls, or a terminal
      // provider error — see HermesCliExecutor's provider error sniffer).
      // Next chat turn will start fresh instead of trying to resume into
      // a broken transcript.
      //
      // 中断态不视为 poison —— codex 的 turn_aborted 走自己的清理路径,
      // session 可以正常续聊。只有 invalidateSession=true 且非用户主动中断
      // 时才丢弃 sessionId。
      if (groupId && result.invalidateSession && !task.aborted) {
        this.sessionStore.delete(this.cliTool, groupId);
        console.warn(
          `${this.tag} Session invalidated: ${this.cliTool}:${groupId}` +
          (result.failed ? " (provider error)" : " (poisoned history)"),
        );
        this.sendSessionSnapshot();
      } else if (groupId && result.sessionId) {
        // Persist sessionId for future messages in this group
        this.sessionStore.set(this.cliTool, groupId, result.sessionId);
        console.log(`${this.tag} Session stored: ${this.cliTool}:${groupId} → ${result.sessionId}`);
        this.sendSessionSnapshot();
      }

      if (task.aborted) {
        // 用户中断:已积累的 partial content 落库(走 master 的 cancelled_at 路径),
        // bubble 切到「已中断」状态。不暴露 executor 返回的 aborted 错误文案 ——
        // 用户自己点的中断,不需要再看"turn was aborted" 之类的内部噪声。
        this.sendChatEnd(requestId, fullContent, conversation, cwd, undefined, { cancelled: true });
        console.log(`${this.tag} Reply cancelled mid-stream to ${fromName} (kept ${fullContent.length} chars)`);
      } else {
        // Provider-error path: executor detected a terminal model failure
        // (e.g. hermes's "API call failed after N retries: …" reply, which
        // is not a legitimate assistant message). Surface it as a clean
        // [错误] notice instead of streaming the error string as the
        // agent's "answer". The dashboard's status pill is already on
        // "Failed" from the executor's [status:Failed] emit.
        if (result.failed) {
          const reason = result.errorMessage || "unknown provider error";
          this.sendChatEnd(
            requestId,
            `[错误] 模型调用失败：${reason}\n（已清空会话上下文,下一条消息将重新开始）`,
            conversation,
            cwd,
            composed,
          );
          console.error(`${this.tag} Provider error surfaced to ${fromName}: ${reason}`);
        } else {
          this.sendChatEnd(requestId, fullContent, conversation, cwd, composed);
          console.log(`${this.tag} Reply sent to ${fromName} (${fullContent.length} chars)`);
        }
      }
    } catch (err: any) {
      if (task.aborted) {
        // 子进程被 SIGTERM/SIGKILL 时 executor 可能 throw(SIGNAL error),
        // 这是用户主动取消的预期结果,走 cancelled 终态而不是 error。
        this.sendChatEnd(requestId, fullContent, conversation, cwd, undefined, { cancelled: true });
        console.log(`${this.tag} Reply cancelled (executor threw on abort) to ${fromName} (kept ${fullContent.length} chars)`);
      } else {
        this.sendChatEnd(requestId, `[错误] ${err.message}`, conversation, cwd, composed);
        console.error(`${this.tag} Reply error:`, err.message);
      }
    } finally {
      this.activeTasks.delete(taskKey);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Handle collaboration_started notification — generate initial contribution. */
  private async handleCollaborationStarted(
    issueId: string, title: string, collaborationGoal: string,
    participants: string[], round: number, maxRounds: number, groupId: string,
  ): Promise<void> {
    const taskKey = `collab-${issueId}`;
    if (this.activeTasks.has(taskKey)) return;

    const controller = new AbortController();
    const task = { aborted: false, controller };
    this.activeTasks.set(taskKey, task);

    const sessionId = groupId ? this.sessionStore.get(this.cliTool, groupId) : undefined;

    try {
      const body = [
        `你被指定为协作任务「${title}」的首位发言人，由你来推进协作并决策走向。`,
        `协作目标：${collaborationGoal}`,
        `参与者：${participants.join("、")}（你在第一位，其余成员等待你 @ 邀请发言）`,
        `当前轮次：第 ${round} 轮 / 共 ${maxRounds} 轮`,
        `IssueId：${issueId}`,
        ``,
        `行动指引（按这个顺序考虑）：`,
        `1) 先在群里发表你的初步观点 / 方案 / 问题分析`,
        `2) 决定下一步：`,
        `   - 若需要其他成员补充：用 rotom group send 在 message 开头 @目标名字，等待对方回复后再继续`,
        `   - 若已经达成目标、或继续协作收益不大：调用 rotom collab conclude ${issueId} --summary "..." 主动结束`,
        `3) 不要尝试一次 @ 多个人；每轮只 @ 一位下一个发言人`,
        `4) 不要替别人代答；等他们的真实回复`,
      ].join("\n");

      // cwd 按 groupId 派生
      const cwd = this.resolveIssueCwd(groupId);
      // collab 模式也没有 activeIssues(group-basic 层折叠),只拼 rotom-cli +
      // agent-role + cwd + task 四层。
      const composed = composePrompt({
        mode: "collab",
        agentName: this.config.name,
        agentProfile: this.agentProfile,
        group: null,
        cwd,
        body,
      });
      const collabExecOptions: Parameters<typeof this.executor.execute>[3] = { signal: controller.signal, env: this.agentEnv(), kind: "collab" };
      if (sessionId) collabExecOptions.sessionId = sessionId;
      const result = await this.executor.execute(composed.final, cwd, (_chunk) => {
        if (task.aborted) return;
        // Stream chunks — the agent's tools handle communication
      }, collabExecOptions);

      if (groupId && result.invalidateSession) {
        this.sessionStore.delete(this.cliTool, groupId);
        this.sendSessionSnapshot();
      } else if (groupId && result.sessionId) {
        this.sessionStore.set(this.cliTool, groupId, result.sessionId);
        this.sendSessionSnapshot();
      }

      if (task.aborted) return;

      // The agent's tools (rotom group send) handle communication.
      // The collaboration tracking in Master will pick up the group messages automatically.
      console.log(`${this.tag} Collaboration contribution ready for "${title}" (${result.fullOutput.length} chars)`);
    } catch (err: any) {
      if (!task.aborted) {
        console.error(`${this.tag} Collaboration error:`, err.message);
      }
    } finally {
      this.activeTasks.delete(taskKey);
    }
  }

  private extractArtifacts(output: string): string[] {
    const artifacts: string[] = [];
    const patterns = [
      /(?:created|modified|wrote|updated)\s+`?([^\s`]+\.\w+)`?/gi,
      /(?:Editing|Creating)\s+([^\s:]+\.\w+)/gi,
    ];
    for (const p of patterns) {
      let m;
      while ((m = p.exec(output)) !== null) {
        if (!artifacts.includes(m[1])) artifacts.push(m[1]);
      }
    }
    return artifacts;
  }
}
