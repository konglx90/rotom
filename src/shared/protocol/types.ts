/**
 * Base value interfaces used across the mesh protocol — agent info, file
 * references, conversation context, message payload, todos, token usage,
 * session entries. Pulled out of the protocol god-file so master DB rows,
 * dashboard types, and executor code can share these without dragging in
 * the full ClientMessage/ServerMessage unions.
 */

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

/** Instance info sent during auth. */
export interface InstanceInfo {
  instanceId: string;
  hostname: string;
  platform: string;
  endpoint?: string; // e.g. "ws://127.0.0.1:18789"
}

export interface FileRef {
  name: string;
  uri: string;
  mimeType?: string;
}

export interface ActiveIssueRef {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  priority?: string;
}

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

export interface MessagePayload {
  message: string;
  files?: FileRef[];
}

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

export interface OfflineMsg {
  from: AgentInfo;
  payload: MessagePayload;
  routeType: string;
  createdAt: string;
}

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
  /** CLI tool name (claude | codex | hermes). */
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
