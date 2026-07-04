/**
 * Client → Master message definitions.
 *
 * Includes the `ClientMessage` union plus every concrete ClientXxxMessage
 * shape. Consumers can import just this module to type incoming WS frames
 * without pulling in server-side definitions.
 */

import type {
  AgentProfile,
  ConversationContext,
  InstanceInfo,
  MessagePayload,
  SessionEntry,
  TodoItem,
  TokenUsage,
} from "./types.js";

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
  /**
   * 认证 token。OPC 本机模式下可空 —— master 端 `isLoopback(remoteAddr)`
   * 命中时走 `authenticateLocal` 直通(详见 src/master/auth.ts),无需 mesh_token。
   * 跨机连接远程 master 时仍然必填。
   */
  token?: string;
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
