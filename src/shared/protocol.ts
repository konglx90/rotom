/**
 * Digital Employee Mesh — Protocol definitions
 *
 * All WebSocket message types between Agent and Master.
 * 16 message types total: 7 client → master, 9 master → client.
 * + Issue system: 1 client → master, 3 master → client.
 * + Collaboration system: 1 client → master, 3 master → client.
 */

// ---------------------------------------------------------------------------
// Real person enum (human team members who can own collaboration issues)
// ---------------------------------------------------------------------------

export const REAL_PERSONS = ["孔令飞"] as const;
export type RealPerson = typeof REAL_PERSONS[number];

// ---------------------------------------------------------------------------
// Agent info (used in directory, messages, etc.)
// ---------------------------------------------------------------------------

export interface AgentProfile {
  position?: string;
  responsibilities?: string;
  tech_stack?: string;
  /** Agent 组别: "快反组" | "稳交付组" | "真人" */
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
  collaboration?: CollaborationContext;
  /**
   * Active task issues in the group (non-collaboration). Master attaches this
   * so agents can decide whether file writes are allowed. Empty/undefined
   * means agents must Read-only and ask for an issue first.
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

/** Active collaboration metadata for an in-flight group message. */
export interface CollaborationContext {
  issueId: string;
  title: string;
  goal: string;
  participants: string[];
  currentRound: number;
  maxRounds: number;
  owner?: string;
  /** Full text of all turns recorded in the previous round (round = currentRound - 1). */
  lastRoundTurns: { agentName: string; content: string }[];
  /** Names of agents who already spoke in rounds earlier than the previous one. */
  earlierSpeakers: string[];
}

// ---------------------------------------------------------------------------
// Message payload
// ---------------------------------------------------------------------------

export interface MessagePayload {
  message: string;
  files?: FileRef[];
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
  | ClientGroupHistoryRequestMessage
  | ClientGroupMembersRequestMessage
  | ClientUpdateInfoMessage
  | ClientDisconnectMessage
  | ClientIssueUpdateMessage
  | ClientIssueApprovalRequestMessage
  | ClientCreateIssueMessage
  | ClientCreateCollaborationMessage
  | ClientConcludeCollaborationMessage;

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
}

export interface ClientA2AReplyMessage {
  type: "a2a_reply";
  requestId: string;
  payload: MessagePayload;
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
}

export interface ClientGroupHistoryRequestMessage {
  type: "group_history_request";
  requestId: string;
  groupId: string;
  limit?: number;
}

export interface ClientGroupMembersRequestMessage {
  type: "group_members_request";
  requestId: string;
  groupId: string;
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

// --- Issue system (稳交付组 Agent → Master) ---

export interface ClientIssueUpdateMessage {
  type: "issue_update";
  issueId: string;
  status: "in_progress" | "completed" | "failed";
  content?: string;
  metadata?: { artifacts?: string[]; [key: string]: unknown };
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

/** Agent 调用：在指定群创建 Issue，交由稳交付组处理 */
export interface ClientCreateIssueMessage {
  type: "create_issue";
  requestId: string;
  groupId: string;
  title: string;
  description?: string;
  priority?: string;
  workingDir?: string;
}

// --- Collaboration system (Agent → Master) ---

/** Agent 调用：创建协作 Issue，邀请多个 agent 围绕目标自主协作。
 * 协作启动后只会通知 participants[0]，由其自主决策 @ 下一个成员或结束 issue。*/
export interface ClientCreateCollaborationMessage {
  type: "create_collaboration";
  requestId: string;
  groupId: string;
  title: string;
  collaborationGoal: string;
  participants: string[];
  maxRounds: number;
  /** 可选：协作负责人（真人）。不填则该协作没有负责人 */
  owner?: string;
}

/** Agent 调用：主动结束一个进行中的协作 Issue 并广播总结 */
export interface ClientConcludeCollaborationMessage {
  type: "conclude_collaboration";
  issueId: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Master → Client messages (8 types)
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
  | ServerGroupHistoryResponseMessage
  | ServerGroupMembersResponseMessage
  | ServerIssueCreatedMessage
  | ServerIssueAssignedMessage
  | ServerIssueUpdateAckMessage
  | ServerIssueApprovalResponseMessage
  | ServerCreateIssueResponseMessage
  | ServerCollaborationStartedMessage
  | ServerCollaborationConcludedMessage
  | ServerCreateCollaborationResponseMessage
  | ServerIssueCancelledMessage
  | ServerIssueChangedMessage
  | ServerIssueContinueMessage
  | ServerIssueAppendMessage;

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
}

export interface ServerGroupHistoryResponseMessage {
  type: "group_history_response";
  requestId: string;
  messages: { id: number; sender: string; content: string; mentions: string; created_at: string }[];
  error?: string;
}

export interface ServerGroupMembersResponseMessage {
  type: "group_members_response";
  requestId: string;
  members: { agent_name: string; joined_at: string; profile?: AgentProfile }[];
  error?: string;
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
  /** 工具调用审批策略。默认 'r_allow'（写需人工审批，读放行）；
   *  'rw_allow' 时 worker 不挂审批回调，writes 也自动通过。 */
  approvalPolicy?: "r_allow" | "rw_allow";
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

/** Master 回复 Agent 的 create_issue 调用结果 */
export interface ServerCreateIssueResponseMessage {
  type: "create_issue_response";
  requestId: string;
  issueId: string;
  title: string;
  status: string;
  error?: string;
}

// --- Collaboration system (Master → Client) ---

/** 通知 Agent 有新的协作开始 */
export interface ServerCollaborationStartedMessage {
  type: "collaboration_started";
  issueId: string;
  groupId: string;
  title: string;
  collaborationGoal: string;
  participants: string[];
  maxRounds: number;
  /** 可选：协作负责人（真人）。不填则没有负责人 */
  owner?: string;
  round: number;
  /** 群默认 workingDir，agent 执行时若有则作为 cwd 优先于自身 workingDir。 */
  workingDir?: string;
}

/** 协作结论广播 */
export interface ServerCollaborationConcludedMessage {
  type: "collaboration_concluded";
  issueId: string;
  groupId: string;
  title: string;
  summary: string;
  totalRounds: number;
  /** 可选：协作负责人。不填则没有负责人 */
  owner?: string;
}

/** Master 回复 create_collaboration 的结果 */
export interface ServerCreateCollaborationResponseMessage {
  type: "create_collaboration_response";
  requestId: string;
  issueId: string;
  title: string;
  status: string;
  error?: string;
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
 * Master → Agent: user submitted a follow-up input on a completed/failed issue.
 * The agent should re-spawn its CLI with the saved sessionId so the new prompt
 * continues the previous conversation. Falls back to a fresh session if
 * sessionId is empty (e.g. the original run failed before emitting one).
 */
export interface ServerIssueContinueMessage {
  type: "issue_continue";
  issueId: string;
  groupId?: string;
  prompt: string;
  sessionId?: string;
  workingDir?: string;
  /** 续聊时保持 issue 创建时声明的 slash command 模式一致（如 "/plan"）。 */
  slashCommand?: string;
  /** 见 ServerIssueAssignedMessage.approvalPolicy。 */
  approvalPolicy?: "r_allow" | "rw_allow";
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
  groupId?: string;
  prompt: string;
  sessionId?: string;
  workingDir?: string;
  slashCommand?: string;
  /** 见 ServerIssueAssignedMessage.approvalPolicy。 */
  approvalPolicy?: "r_allow" | "rw_allow";
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
    case "group_history_request":
      return typeof msg.requestId === "string" && typeof msg.groupId === "string";
    case "group_members_request":
      return typeof msg.requestId === "string" && typeof msg.groupId === "string";
    case "update_info":
      return true;
    case "disconnect":
      return true;
    case "issue_update":
      return typeof msg.issueId === "string" && typeof msg.status === "string";
    case "issue_approval_request":
      return typeof msg.issueId === "string"
        && typeof msg.approvalId === "string"
        && (msg.kind === "exec" || msg.kind === "file_change" || msg.kind === "plan" || msg.kind === "ask")
        && typeof msg.summary === "string";
    case "create_issue":
      return typeof msg.requestId === "string" && typeof msg.groupId === "string" && typeof msg.title === "string";
    case "create_collaboration":
      return typeof msg.requestId === "string" && typeof msg.groupId === "string" && typeof msg.title === "string" && typeof msg.collaborationGoal === "string" && Array.isArray(msg.participants) && typeof msg.maxRounds === "number" && (msg.owner === undefined || typeof msg.owner === "string");
    case "conclude_collaboration":
      return typeof msg.issueId === "string" && typeof msg.summary === "string";
    default:
      return false;
  }
}
