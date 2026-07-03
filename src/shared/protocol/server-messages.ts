/**
 * Master → Client message definitions.
 *
 * Includes the `ServerMessage` union plus every concrete ServerXxxMessage
 * shape. Consumers can import just this module to type outgoing WS frames
 * without pulling in client-side definitions.
 */

import type {
  AgentInfo,
  AgentProfile,
  ConversationContext,
  MessagePayload,
  OfflineMsg,
  SessionEntry,
  TokenUsage,
} from "./types.js";

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
