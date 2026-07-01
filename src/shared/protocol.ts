/**
 * Digital Employee Mesh — Protocol definitions
 *
 * All WebSocket message types between Agent and Master.
 */

// ---------------------------------------------------------------------------
// Real person enum (human team members who can own issues / approve)
// ---------------------------------------------------------------------------

export const REAL_PERSONS = ["孔令飞"] as const;
export type RealPerson = typeof REAL_PERSONS[number];

// ---------------------------------------------------------------------------
// Agent info (used in directory, messages, etc.)
// ---------------------------------------------------------------------------

export interface AgentProfile {
  position?: string;
  /** 简介自由文本。 */
  bio?: string;
  /** Agent 类别: "真人" | 默认（普通 agent） */
  category?: string;
}

export interface AgentInfo {
  name: string;
  domain?: string;
  description?: string;
  status: "online" | "offline";
  enabled?: boolean;
  profile?: AgentProfile;
}

// ---------------------------------------------------------------------------
// Instance info (sent during auth)
// ---------------------------------------------------------------------------

export interface InstanceInfo {
  instanceId: string;
  hostname: string;
  platform: string;
  endpoint?: string; // e.g. "ws://127.0.0.1:18789"
}

// ---------------------------------------------------------------------------
// File reference
// ---------------------------------------------------------------------------

export interface FileRef {
  name: string;
  uri: string;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Conversation context (single vs group)
// ---------------------------------------------------------------------------

export interface ConversationContext {
  type: "single" | "group";
  groupId?: string;
  groupName?: string;
  /**
   * Active task issues in the group. Master attaches this so agents can
   * decide whether file writes are allowed. Empty/undefined means agents
   * must Read-only and ask for an issue first.
   */
  activeIssues?: ActiveIssueRef[];
  /**
   * Default working directory for the group/DM. Executor uses it as cwd for
   * chat replies when no per-issue workingDir is in effect. Falls back to the
   * worker's own workingDir when undefined.
   */
  workingDir?: string;
}

/** Reference to an in-progress / open task issue, included in group prompts. */
export interface ActiveIssueRef {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  priority?: string;
}

/**
 * Looser shape of `ConversationContext` for prompt-injection use. Only the
 * fields `injectGroupContext` reads are declared (all optional so the caller
 * can pass a partial / unknown payload and let the function short-circuit).
 */
export interface GroupConversation {
  type?: string;
  groupId?: string;
  groupName?: string;
  activeIssues?: ActiveIssueRef[];
  /** 群内 + 全局可被 agent 检索的记忆条数(极简指针注入用)。 */
  memoryCounts?: { group: number; global: number };
  /** 当前 agent 在该群绑定的 skill 数(极简指针注入用,per-agent)。 */
  skillCount?: number;
}

// ---------------------------------------------------------------------------
// Message payload
// ---------------------------------------------------------------------------

export interface MessagePayload {
  message: string;
  files?: FileRef[];
}

// ---------------------------------------------------------------------------
// Todo item (Claude Code TodoWrite tool payload)
// ---------------------------------------------------------------------------

/**
 * 单条 todo,镜像 Claude Code TodoWrite 工具的 input.todos 数组项结构。
 * Worker 解析 stream-json 时整条数组透传给 master,master 落库到
 * issues.latest_todos_json + 一条 event_type='todos' 的 issue_event。
 */
export interface TodoItem {
  /** 任务描述,用户在 dashboard 上看到的主要文本。 */
  content: string;
  /** 状态:pending=待办 / in_progress=进行中 / completed=已完成。 */
  status: "pending" | "in_progress" | "completed";
  /** 进行时态的简短描述(Claude Code 会填,如 "Fixing authentication bug")。
   *  可选,缺失时前端 fallback 到 content。 */
  activeForm?: string;
}

// ---------------------------------------------------------------------------
// Offline message (pushed on reconnect)
// ---------------------------------------------------------------------------

export interface OfflineMsg {
  from: AgentInfo;
  payload: MessagePayload;
  routeType: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Client → Master messages (5 types)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | ClientAuthMessage
  | ClientHeartbeatMessage
  | ClientA2ASendMessage
  | ClientA2AReplyMessage
  | ClientA2AReplyChunkMessage
  | ClientA2AReplyEndMessage
  | ClientUpdateInfoMessage
  | ClientDisconnectMessage
  | ClientIssueUpdateMessage
  | ClientIssueTodosUpdateMessage
  | ClientIssueUsageProgressMessage
  | ClientIssueApprovalRequestMessage
  | ClientSubscribeIssueDetailMessage
  | ClientUnsubscribeIssueDetailMessage
  | ClientSessionViewResponse
  | ClientSessionDeleteResponse
  | ClientSessionSnapshot
  | ClientSessionInvalidated;

export interface ClientAuthMessage {
  type: "auth";
  /** Protocol version — Master uses this to reject incompatible agents */
  version?: number;
  token: string;
  /** JWT from a previous auth_ok — used for fast reconnect without raw token */
  jwt?: string;
  name: string;
  description?: string;
  domain?: string;
  instance?: InstanceInfo;
  profile?: AgentProfile;
  /**
   * CLI tool name this executor is bound to (claude | codex | hermes | openclaw).
   * Master caches it on the WS connection so /sessions endpoints can route
   * session list/view/delete requests to the right worker.
   */
  cliTool?: string;
}

export interface ClientHeartbeatMessage {
  type: "heartbeat";
  activeDispatches?: number;
}

export interface ClientA2ASendMessage {
  type: "a2a_send";
  requestId: string;
  target?: string;
  payload: MessagePayload;
  conversation?: ConversationContext;
  /** Q&A 模式:worker 收到后跳过 @-mention 检查直接处理;master 收到对应
   *  reply 时硬剥掉 @<asker> 防止 asker worker 被回触发。由 sendAsAgent
   *  的 needReply=true 触发。 */
  qaMode?: boolean;
}

export interface ClientA2AReplyMessage {
  type: "a2a_reply";
  requestId: string;
  payload: MessagePayload;
  /** Cwd the agent actually used for this reply. Surfaced in the dashboard
   *  chat bubble so users can see where the agent was running. */
  cwd?: string;
}

export interface ClientA2AReplyChunkMessage {
  type: "a2a_reply_chunk";
  requestId: string;
  delta: string;
}

export interface ClientA2AReplyEndMessage {
  type: "a2a_reply_end";
  requestId: string;
  payload: MessagePayload;
  /** Cwd the agent actually used. Sent once at end-of-turn. */
  cwd?: string;
  /**
   * Set when the reply was interrupted mid-stream (user clicked ⏹ or sent a
   * new message that auto-cancels this one). `payload.message` carries the
   * partial content streamed before the abort; master still persists it so
   * the user keeps the context.
   */
  cancelled?: boolean;
}

export interface ClientUpdateInfoMessage {
  type: "update_info";
  description?: string;
  /** @deprecated Master ignores this field — domain is master-owned. */
  domain?: string;
  profile?: AgentProfile;
}

export interface ClientDisconnectMessage {
  type: "disconnect";
}

// --- Issue system (Agent → Master) ---

export interface ClientIssueUpdateMessage {
  type: "issue_update";
  issueId: string;
  status: "in_progress" | "completed" | "failed" | "paused";
  content?: string;
  metadata?: { artifacts?: string[]; [key: string]: unknown };
  /** Cwd the agent used while executing this issue. */
  cwd?: string;
}

/**
 * Agent → Master: codex / cli executor needs the user to approve an action
 * (shell exec or file change) before it can proceed. Master persists this as
 * an `approval_request` issue_event and forwards the eventual decision via
 * `issue_approval_response`. While the user thinks, codex stays parked on
 * the JSON-RPC request inside the executor.
 */
export interface ClientIssueApprovalRequestMessage {
  type: "issue_approval_request";
  issueId: string;
  /** Worker-generated UUID; used by Master to route the decision back. */
  approvalId: string;
  kind: "exec" | "file_change" | "plan" | "ask";
  /** One-line description for the dashboard list view. */
  summary: string;
  /** kind=exec: full shell command. */
  command?: string;
  /** kind=exec: working directory codex would run the command in. */
  cwd?: string;
  /** kind=file_change: paths codex wants to create / modify / delete. */
  files?: string[];
  /** kind=plan: markdown plan body for the user to approve. */
  plan?: string;
  /** kind=file_change: diff details for edit/write/multiEdit operations. */
  diff?: {
    tool: string;
    hunks: Array<{ old_string: string; new_string: string }>;
    new_content?: string;
    truncated?: boolean;
  };
  /** kind=ask: structured questions (AskUserQuestion tool input). */
  questions?: Array<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: Array<{ label: string; description: string }>;
  }>;
}

/**
 * Agent → Master: claude (或其他支持 TodoWrite 概念的 CLI) 在干活期间
 * 调用 TodoWrite 工具更新自己的 todo 列表。Worker 解析 stream-json 的
 * tool_use 块提取 input.todos,完整数组透传给 master。
 *
 * Master 处理:
 *   1. 覆盖式写入 issues.latest_todos_json(最新快照)
 *   2. 与上一次内容比对,不同才追加一条 event_type='todos' 的 issue_event
 *      (供时间线展示历史变化,做内容 hash 去重避免噪声)
 *   3. notifyIssueChanged 推送给 dashboard
 *
 * 注意:issue_todos_update 不携带 status 字段(不像 issue_update),它
 * 不会改 issue 状态,只是 side-channel 推送 todos 视图。
 */
export interface ClientIssueTodosUpdateMessage {
  type: "issue_todos_update";
  issueId: string;
  /** 完整 todos 数组,worker 每次都发全量(claude 的 TodoWrite 本身就是全量)。 */
  todos: TodoItem[];
}

/**
 * Agent → Master: 执行过程中实时上报 token usage 增量(每条 assistant 消息
 * 触发一次)。Master **不落 DB**——只在内存累积值,按 issueId 路由推送给订阅
 * 了该 issue 详情的 dashboard 客户端(见 ClientSubscribeIssueDetailMessage)。
 *
 * 与 issue_todos_update 的区别:
 *   - todos 是覆盖式全量,直接写 issues.latest_todos_json
 *   - usage 是增量,Master 端不累积(由 worker 节流后给累积值),只做转发
 *
 * Worker 端做 leading+trailing 1s 节流,避免高频 assistant 事件打爆 WS。
 * 终态(completed/failed)时 worker 用 result.usage 覆盖累积值并强制 flush
 * 一次,保证 reload 后看到的 issue.usage 与最后一次推送一致。
 */
export interface ClientIssueUsageProgressMessage {
  type: "issue_usage_progress";
  issueId: string;
  /** 累积 usage 快照(不是增量)——worker 已 merge 完毕,Master 直接转发。 */
  usage: TokenUsage;
}

/**
 * Dashboard → Master: 订阅 / 取消订阅某个 issue 详情的实时推送。当前仅用于
 * issue_usage_progress —— 不广播给所有群成员,只推给订阅了该 issueId 的客户端。
 *
 * 订阅键是 WS 连接的 agentId。Master 在 connection close / "Replaced by new
 * connection" 路径必须清理订阅,避免泄漏。客户端 ws onopen 后必须重发当前
 * 订阅(订阅不会跨重连保留)。
 *
 * 引用计数由 Master 端 Set 天然处理:多个 connection 同时订阅同一 issueId
 * 是允许的(多 dashboard 看同一 issue),Set 去重;unsubscribe 只删当前连接。
 */
export interface ClientSubscribeIssueDetailMessage {
  type: "subscribe_issue_detail";
  issueId: string;
}

export interface ClientUnsubscribeIssueDetailMessage {
  type: "unsubscribe_issue_detail";
  issueId: string;
}

// --- Session management (Agent → Master) ---
//
// Workers answer the master's session_list/view/delete_request messages with
// these. The requestId ties the response back to the pending HTTP request
// served by /sessions. Each worker reports its own entries (keyed
// `${cliTool}:${groupId}` in its local SessionStore) — Master aggregates.

/**
 * Per-session token / cost usage reported by the underlying CLI. All fields
 * optional — backends surface whatever they have. Codex/Hermes/Claude emit
 * different subsets; the dashboard degrades gracefully on missing fields.
 *
 * Canonical home is here (shared protocol) so both master and executor can
 * use it without cross-module imports. `cli-executor.ts` re-exports it for
 * backward compatibility with executor implementations.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Total session cost in USD, if the backend reports it (claude does). */
  totalCostUsd?: number;
}

/** One session entry as reported by a single worker. */
export interface SessionEntry {
  /** CLI tool name (claude | codex | hermes | openclaw). */
  cliTool: string;
  /** Group / DM id the session is bound to. */
  groupId: string;
  /** Underlying CLI session id (hex/uuid). The actual transcript lives in
   *  the executor's local FS (e.g. `~/.claude/projects/<cwd>/<id>.jsonl`). */
  sessionId: string;
  /** Name of the agent that owns this session. Populated by master when
   *  aggregating snapshots (the sessionSnapshots Map is keyed by agentId),
   *  so the dashboard can show "which agent" rather than just the cliTool.
   *  Not sent by workers — they don't know their own agent name. */
  agentName?: string;
  /** Latest token/cost usage captured from the CLI backend for this chat
   *  session. Updated by the worker after each chat turn (handleChatReply
   *  reads result.usage). Master just caches what the worker pushes —
   *  no DB lookup. Null/undefined means the worker hasn't reported yet
   *  (first turn still running, or backend doesn't emit usage). */
  usage?: TokenUsage | null;
  /** Backend-reported model name for the latest chat turn in this session
   *  (e.g. `claude-sonnet-4-6`, `gpt-5`). Same lifecycle as `usage`. */
  model?: string | null;
  /** 累计成本(USD),跨该 chat session 所有 turn 的 totalCostUsd 之和。
   *  worker 在 session_snapshot 里推送,master 缓存后透传给 dashboard。
   *  session 失效重建(sessionId 变更)时清零。undefined 表示从未报告过 cost。 */
  cumulativeCostUsd?: number;
  /** 累计 token 数,跨该 session 所有 turn 之和。同 cumulativeCostUsd 语义。 */
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCacheReadTokens?: number;
  cumulativeCacheCreationTokens?: number;
  /** 该 session 的 worker 当前是否 WS 连着 master。由 master 在
   *  listSessionsByGroup 里 join connections 算出,不持久化。 */
  online?: boolean;
  /** ISO 时间戳;非 null 表示该 session 已被 worker 标记失效(poison /
   *  provider error / 用户主动删)。null = 仍 active。 */
  invalidatedAt?: string | null;
}

export interface ClientSessionViewResponse {
  type: "session_view_response";
  requestId: string;
  groupId: string;
  sessionId: string;
  /** "jsonl" for claude-code style line-delimited JSON, "text" or "raw" otherwise. */
  format: "jsonl" | "text" | "raw";
  /** Tail of the session content. Empty string if the executor's CLI backend
   *  cannot introspect its own session (codex/hermes/openclaw — see plan §3). */
  content: string;
  /** Set when the executor failed to read (file missing, etc.). */
  error?: string;
}

export interface ClientSessionDeleteResponse {
  type: "session_delete_response";
  requestId: string;
  groupId: string;
  sessionId: string;
  ok: boolean;
  /** Human-readable failure reason (e.g. "session not found"). */
  error?: string;
}

/**
 * Unprompted snapshot of every (cliTool, groupId, sessionId) tuple the worker
 * currently has in its SessionStore. Workers push this:
 *  1. immediately after a successful `auth` (initial sync), and
 *  2. after every SessionStore mutation (set / delete) — full-array semantics,
 *     master replaces its cached entry for this worker on each receipt.
 *
 * The master keeps an in-memory Map<workerAgentId, entries[]> so the dashboard
 * `GET /sessions?groupId=X` can be answered locally without broadcasting.
 *
 * Full-array (not diff) chosen deliberately: SessionStore tends to have <100
 * entries per worker, so the cost is trivial and we avoid sync drift bugs.
 */
export interface ClientSessionSnapshot {
  type: "session_snapshot";
  entries: SessionEntry[];
}

/**
 * Worker → Master:某个 session 被 worker 主动失效(poison / provider error /
 * dashboard 用户主动删)。master 不删行,只打 invalidated_at 戳,保留历史。
 *
 * 与 session_snapshot 的区别:snapshot 是全量替换 worker 的 active 列表,
 * 适合"状态同步";invalidated 是单条事件的明确信号,适合"这条 session 不再
 * 用于 resume 了,但请在 DB 里保留它"。
 */
export interface ClientSessionInvalidated {
  type: "session_invalidated";
  cliTool: string;
  groupId: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Master → Client messages
// ---------------------------------------------------------------------------

export type ServerMessage =
  | ServerAuthOkMessage
  | ServerAuthFailMessage
  | ServerHeartbeatAckMessage
  | ServerA2AMessage
  | ServerRouteResultMessage
  | ServerDirectoryUpdateMessage
  | ServerOfflineMessagesMessage
  | ServerUpdateInfoAckMessage
  | ServerConfigUpdateMessage
  | ServerA2AStreamChunkMessage
  | ServerA2AStreamEndMessage
  | ServerIssueCreatedMessage
  | ServerIssueAssignedMessage
  | ServerIssueUpdateAckMessage
  | ServerIssueApprovalResponseMessage
  | ServerIssueCancelledMessage
  | ServerChatCancelledMessage
  | ServerIssueChangedMessage
  | ServerIssueContinueMessage
  | ServerIssueAppendMessage
  | ServerIssueInterruptMessage
  | ServerIssueUsageProgressMessage
  | ServerSessionViewRequest
  | ServerSessionDeleteRequest
  | ServerSessionSyncPush;

export interface ServerAuthOkMessage {
  type: "auth_ok";
  /** Protocol version supported by Master */
  version?: number;
  jwt: string;
  directory: AgentInfo[];
  /** Master-assigned config pushed to Agent on connect */
  config?: { domain?: string; enabled?: boolean };
}

export interface ServerAuthFailMessage {
  type: "auth_fail";
  reason: string;
}

export interface ServerHeartbeatAckMessage {
  type: "heartbeat_ack";
}

export interface ServerA2AMessage {
  type: "a2a_message";
  requestId: string;
  from: AgentInfo;
  payload: MessagePayload;
  routeType: string;
  conversation?: ConversationContext;
  /** Cwd the sending agent was using. Filled in by master from the upstream
   *  ClientA2AReplyMessage / ClientA2AReplyEndMessage. */
  cwd?: string;
  /** Master 在 dispatch 时从 agents.profile 注入,worker 收到后更新本地缓存
   *  供 prompt-composer 渲染 agent-role 层。字段缺失时 worker 沿用启动时
   *  从 executor.config.json 读到的兜底值。 */
  agentProfile?: AgentProfile;
  /** 内置 repo(migration 051):master 从 group.repo_url 解析后下发。worker 收到
   *  后在 chat 路径也走 group 模式 worktree(共享 worktree,不依赖 issueId),
   *  让群内对话能查 repo 代码。缺失/空 = 该 group 未启用 repo,chat 走老 cwd。 */
  repoUrl?: string;
  repoBranch?: string;
  extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
  worktreeMode?: string;
}

export interface ServerRouteResultMessage {
  type: "route_result";
  requestId: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
}

export interface ServerDirectoryUpdateMessage {
  type: "directory_update";
  event: "join" | "leave" | "update";
  agent: AgentInfo;
}

export interface ServerOfflineMessagesMessage {
  type: "offline_messages";
  messages: OfflineMsg[];
}

export interface ServerUpdateInfoAckMessage {
  type: "update_info_ack";
  ok: boolean;
  error?: string;
}

export interface ServerConfigUpdateMessage {
  type: "config_update";
  domain?: string;
  enabled?: boolean;
}

export interface ServerA2AStreamChunkMessage {
  type: "a2a_stream_chunk";
  requestId: string;
  from: AgentInfo;
  delta: string;
  conversation?: ConversationContext;
}

export interface ServerA2AStreamEndMessage {
  type: "a2a_stream_end";
  requestId: string;
  from: AgentInfo;
  conversation?: ConversationContext;
  /** Cwd the sending agent was using. */
  cwd?: string;
}

// --- Issue system (Master → Client) ---

export interface ServerIssueCreatedMessage {
  type: "issue_created";
  issueId: string;
  groupId: string;
  title: string;
  createdBy: string;
}

export interface ServerIssueAssignedMessage {
  type: "issue_assigned";
  issueId: string;
  groupId: string;
  title: string;
  description: string;
  workingDir?: string;
  /** issue 创建时由 master 解析出的 slash command（如 "/plan"）；worker 据此向底层
   *  CLI 注入对应执行模式。未声明时为 undefined。 */
  slashCommand?: string;
  /** 工具调用审批策略。默认 .rw_allow.（读写默认通过，无需人工审批）；
   *  'rw_allow' 时 worker 不挂审批回调，writes 也自动通过。 */
  approvalPolicy?: "r_allow" | "rw_allow";
  /** Master dispatch 时从 agents.profile 注入;worker 收到后更新本地缓存,
   *  供 prompt-composer 渲染 agent-role 层。字段缺失时沿用 executor.config.json
   *  的兜底值。 */
  agentProfile?: AgentProfile;
  /** 内置 repo(migration 051):master 从 group.repo_url + issue.repo_url 解析后下发。
   *  worker 收到后在 executor 本机 ensureBareClone + git worktree add,
   *  返回 primary worktree 路径作为 agent cwd(替代 workingDir)。
   *  缺失/空 = 该 group 未启用 repo,worker 走原 resolveIssueCwd 三层回落。 */
  repoUrl?: string;
  /** 主仓库分支。优先 issue.repo_branch → group.repo_default_branch → 仓库默认。 */
  repoBranch?: string;
  /** 额外仓库 JSON 数组,形如 [{id,url,branch,mountPath}]。每个在 issue 工作区起独立 worktree,
   *  并在 primary 的 mountPath 处建 symlink 让 agent 在 cwd 内直接访问。 */
  extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
}

export interface ServerIssueUpdateAckMessage {
  type: "issue_update_ack";
  issueId: string;
  ok: boolean;
}

/**
 * Master → Agent: the user has resolved a pending approval request. Worker
 * looks up the matching pendingApprovals entry and resolves its Promise so
 * codex (still parked on the JSON-RPC request) can be answered with the
 * matching decision.
 */
export interface ServerIssueApprovalResponseMessage {
  type: "issue_approval_response";
  issueId: string;
  approvalId: string;
  decision: "accept" | "deny";
  /** Optional user-supplied feedback. Only present on `deny`; carries the
   *  reason the user typed so executors can pass it to the underlying CLI as
   *  a meaningful denial reason. */
  feedback?: string;
}

/**
 * Pushed to all members of an issue's group whenever the issue changes
 * (created, status/priority/assignee updated, event appended, or deleted).
 * Dashboard uses this to drop polling. `kind="deleted"` implies the issue
 * no longer exists — consumers should remove it from any local state.
 */
export interface ServerIssueChangedMessage {
  type: "issue_changed";
  issueId: string;
  groupId: string;
  kind: "created" | "updated" | "event_appended" | "deleted";
}

/**
 * Pushed to the executor agent currently assigned to an issue when the issue
 * has been cancelled — the agent should abort the in-flight CLI process.
 */
export interface ServerIssueCancelledMessage {
  type: "issue_cancelled";
  issueId: string;
  groupId?: string;
  reason?: string;
}

/**
 * Master → Agent: user requested an interrupt of the current step (button
 * click or ESC shortcut) while the issue is still in_progress. Unlike
 * `issue_cancelled`, the issue stays in_progress — the agent should abort
 * the in-flight CLI process and let `runIssueExecution`'s finally block
 * decide what's next:
 *   • if `pendingAppends[issueId]` has queued messages → merge them and
 *     `--resume` the CLI with the last sessionId (queue flush, codex-style
 *     "interrupt + process queued steer")
 *   • if queue is empty → no respawn, leave the issue idle in_progress so
 *     the user can keep typing; next append triggers a fresh `--resume` run
 *
 * Distinct from `issue_cancelled` (which flips status to cancelled) and
 * `issue_continue` (which only fires after completed/failed). Interrupt
 * keeps the session alive for immediate resume.
 */
export interface ServerIssueInterruptMessage {
  type: "issue_interrupt";
  issueId: string;
  groupId?: string;
}

/**
 * Master → Dashboard: 执行过程中累积 token usage 的实时快照。Master 收到
 * worker 的 ClientIssueUsageProgressMessage 后,仅转发给订阅了该 issueId 的
 * 连接(不广播、不落 DB)。
 *
 * Dashboard 收到后局部更新 IssueStatusBar 的 token 数字,**不触发 reload**
 * (区别于 issue_changed)——避免每秒高频刷新打爆 useIssueData。
 */
export interface ServerIssueUsageProgressMessage {
  type: "issue_usage_progress";
  issueId: string;
  usage: TokenUsage;
}

/**
 * Master → Agent: a chat reply is being interrupted mid-stream. The worker
 * should look up `activeTasks["chat:" + requestId]`, flip `aborted = true`,
 * and call `controller.abort()` so the underlying CLI executor kills its
 * subprocess (SIGTERM → SIGKILL fallback already wired in all 4 executors).
 *
 * Distinct from `issue_cancelled` because chat tasks are keyed by requestId
 * (not issueId) in the worker's activeTasks map. Master routes this to the
 * single responder agent (the dashboard knows who's currently replying from
 * the streaming bubble's `from` field); if that agent is offline or already
 * finished, the WS send is a no-op on the worker side.
 */
export interface ServerChatCancelledMessage {
  type: "chat_cancelled";
  requestId: string;
  /** Echo of the responder agent name — worker uses it only for log clarity. */
  agentName?: string;
  reason?: string;
}

/**
 * Master → Agent: user submitted a follow-up input on a completed/failed issue.
 * The agent should re-spawn its CLI with the saved sessionId so the new prompt
 * continues the previous conversation. Falls back to a fresh session if
 * sessionId is empty (e.g. the original run failed before emitting one).
 */
export interface ServerIssueContinueMessage {
  type: "issue_continue";
  issueId: string;
  title?: string;
  groupId?: string;
  prompt: string;
  sessionId?: string;
  workingDir?: string;
  /** 续聊时保持 issue 创建时声明的 slash command 模式一致（如 "/plan"）。 */
  slashCommand?: string;
  /** 见 ServerIssueAssignedMessage.approvalPolicy。 */
  approvalPolicy?: "r_allow" | "rw_allow";
  /** 见 ServerIssueAssignedMessage.agentProfile。 */
  agentProfile?: AgentProfile;
  /** 见 ServerIssueAssignedMessage.repoUrl。续跑复用同一 worktree(已存在则幂等)。 */
  repoUrl?: string;
  /** 见 ServerIssueAssignedMessage.repoBranch。 */
  repoBranch?: string;
  /** 见 ServerIssueAssignedMessage.extraRepos。 */
  extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
}

/**
 * Master → Agent: user typed a follow-up while the issue is still active
 * (open / in_progress). The agent queues it on the running task and runs
 * a continuation with --resume <sessionId> after the current CLI call
 * returns. Distinct from issue_continue, which only fires after the
 * issue reaches completed/failed.
 */
export interface ServerIssueAppendMessage {
  type: "issue_append";
  issueId: string;
  title?: string;
  groupId?: string;
  prompt: string;
  sessionId?: string;
  workingDir?: string;
  slashCommand?: string;
  /** 见 ServerIssueAssignedMessage.approvalPolicy。 */
  approvalPolicy?: "r_allow" | "rw_allow";
  /** 见 ServerIssueAssignedMessage.agentProfile。 */
  agentProfile?: AgentProfile;
  /** 见 ServerIssueAssignedMessage.repoUrl。append 续跑同一 issue 的 worktree。 */
  repoUrl?: string;
  /** 见 ServerIssueAssignedMessage.repoBranch。 */
  repoBranch?: string;
  /** 见 ServerIssueAssignedMessage.extraRepos。 */
  extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
}

// --- Session management (Master → Agent) ---
//
// session_view_request / session_delete_request are routed to the worker
// bound to the requested cliTool (auth-time binding, see
// ClientAuthMessage.cliTool). Workers MUST answer every request they receive;
// masters time out after a few seconds.
//
// The list path is NOT here: workers push `session_snapshot` (ClientMessage)
// unsolicited after auth and after every SessionStore mutation, so master
// keeps an always-fresh cache and `GET /sessions` reads it synchronously.

export interface ServerSessionViewRequest {
  type: "session_view_request";
  requestId: string;
  groupId: string;
  sessionId: string;
  /** How many trailing lines to read from the session file. Default 200. */
  tailLines?: number;
}

export interface ServerSessionDeleteRequest {
  type: "session_delete_request";
  requestId: string;
  groupId: string;
  sessionId: string;
}

/**
 * Master → Worker:worker 刚认证成功后,master 把该 (agentName, cliTool) 名下
 * 所有 active(未失效)的 session 推给 worker。worker 用这些填充自己的内存
 * SessionStore,这样后续 chat turn 能 `--resume <sessionId>`。
 *
 * 数据源是 master DB 的 agent_sessions 表(替代了 worker 侧的 sessions.json)。
 * 之后 worker 每次 mutation 会推 session_snapshot 回来,master upsert 到 DB,
 * 双向同步达成。
 */
export interface ServerSessionSyncPush {
  type: "session_sync_push";
  entries: SessionEntry[];
}

// ---------------------------------------------------------------------------
// Type guards (runtime validation for external input)
// ---------------------------------------------------------------------------

export function isClientMessage(x: unknown): x is ClientMessage {
  if (!x || typeof x !== "object") return false;
  const msg = x as Record<string, unknown>;
  if (typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "auth":
      return typeof msg.token === "string" && typeof msg.name === "string";
    case "heartbeat":
      return true;
    case "a2a_send":
      return typeof msg.requestId === "string" && !!msg.payload;
    case "a2a_reply":
      return typeof msg.requestId === "string" && !!msg.payload;
    case "a2a_reply_chunk":
      return typeof msg.requestId === "string" && typeof msg.delta === "string";
    case "a2a_reply_end":
      return typeof msg.requestId === "string" && !!msg.payload;
    case "update_info":
      return true;
    case "disconnect":
      return true;
    case "issue_update":
      return typeof msg.issueId === "string" && typeof msg.status === "string";
    case "issue_todos_update":
      return typeof msg.issueId === "string" && Array.isArray(msg.todos);
    case "issue_usage_progress":
      return typeof msg.issueId === "string" && !!msg.usage;
    case "subscribe_issue_detail":
      return typeof msg.issueId === "string";
    case "unsubscribe_issue_detail":
      return typeof msg.issueId === "string";
    case "issue_approval_request":
      return typeof msg.issueId === "string"
        && typeof msg.approvalId === "string"
        && (msg.kind === "exec" || msg.kind === "file_change" || msg.kind === "plan" || msg.kind === "ask")
        && typeof msg.summary === "string";
    case "session_view_response":
      return typeof msg.requestId === "string"
        && typeof msg.groupId === "string"
        && typeof msg.sessionId === "string"
        && (msg.format === "jsonl" || msg.format === "text" || msg.format === "raw")
        && typeof msg.content === "string";
    case "session_delete_response":
      return typeof msg.requestId === "string"
        && typeof msg.groupId === "string"
        && typeof msg.sessionId === "string"
        && typeof msg.ok === "boolean";
    case "session_snapshot":
      return Array.isArray(msg.entries);
    case "session_invalidated":
      return typeof msg.cliTool === "string"
        && typeof msg.groupId === "string"
        && typeof msg.sessionId === "string";
    default:
      return false;
  }
}
