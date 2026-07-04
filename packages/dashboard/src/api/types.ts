// API Response Types
export interface ApiResponse<T> {
  data?: T
  error?: string
}

// Agent Profile
export interface AgentProfile {
  position?: string
  /** 简介（自由文本）。 */
  bio?: string
  /** Agent 类别: "真人" | 默认（普通 agent） */
  category?: string
}

// Agent Types
export interface Agent {
  id: string
  name: string
  description?: string
  domain?: string
  status: 'online' | 'offline'
  hostname?: string
  endpoint?: string
  /** 当前连接的 CLI 工具(claude/codex/hermes/openclaw/pi)。Offline 时为 null。
   *  由 master 从 hub.connections 查出,DB 不存(那是 worker 运行时属性)。 */
  cliTool?: string | null
  enabled: boolean
  last_heartbeat?: number
  connected_at?: number
  registered_at?: number
  profile?: AgentProfile
  avatar_url?: string | null
  /** Plaintext mesh_* token. Returned by GET /agents/:id only — list endpoints omit it.
   *  Null/undefined for agents registered before migration 016. */
  token?: string | null
  message_stats?: {
    received: number
    sent: number
    avg_latency_ms: number
    failed: number
    replied: number
  }
}

export interface CreateAgentDto {
  name: string
  description?: string
  domain?: string
}

export interface UpdateAgentDto {
  description?: string
  domain?: string
  enabled?: boolean
  profile?: AgentProfile
  avatar_url?: string | null
}

// Domain Types
export interface Domain {
  id: string
  name: string
  description?: string
  created_at: number
  agentCount?: number
}

export interface CreateDomainDto {
  name: string
  description?: string
}

export interface UpdateDomainDto {
  name: string
  description?: string
}

// Cross-Domain Rule Types
export interface CrossDomainRule {
  id: string
  from_domain: string
  to_domain: string
}

export interface CreateRuleDto {
  from: string
  to: string
  bidirectional?: boolean
}

// Message Types
export interface Message {
  id: string
  request_id?: string
  from_agent_id: string
  to_agent_id: string
  from_name?: string
  from_domain?: string | null
  to_name?: string | null
  to_domain?: string | null
  payload: string
  route_type: string
  direction?: 'send' | 'reply' | string
  status?: string
  latency_ms?: number
  timestamp: string
  group_id?: string | null
  source?: string | null
}

export interface MessageListResponse {
  messages: Message[]
  total: number
}

export interface MessagePayload {
  message: string
  files?: Array<{
    name: string
    uri: string
    mimeType?: string
  }>
}

// Conversation Types
export interface Conversation {
  agent_pair: string
  message_count: number
  last_message_at: string
  messages: Message[]
}

// Audit Event Types
export interface AuditEvent {
  id: string
  from_name?: string
  from_domain?: string
  to_name?: string
  to_domain?: string
  route_type?: string
  result?: string
  message_summary?: string
  timestamp: string
}

// Stats Types
export interface Stats {
  status: 'ok' | 'error'
  total: number
  online: number
  domains: number
  agents: Array<{
    name: string
    received: number
    sent: number
    avg_latency_ms: number
    failed: number
    replied: number
  }>
}

// Send Message DTO
export interface SendMessageDto {
  from: string
  to: string
  message: string
}

// Group Types
export interface Group {
  id: string
  name: string
  created_by: string | null
  created_at: string
  working_dir?: string | null
  pinned_at?: string | null
  archived_at?: string | null
  /** 重要少用群时间戳;null=普通活跃群。可读可写,仅用于侧栏分层展示。 */
  starred_at?: string | null
  /** 群级别指导 prompt,全群一份;null/空 = 未设置。 */
  guidance_prompt?: string | null
  /** 内置 repo:主仓库 URL(migration 051)。null/空 = 该 group 走现状(无 worktree)。 */
  repo_url?: string | null
  /** 主仓库默认分支。null 时 worktree 创建用仓库默认分支。 */
  repo_default_branch?: string | null
  /** 额外仓库配置 JSON 数组,形如 [{"id","url","branch","mountPath"}]。null = 无。 */
  extra_repos?: string | null
  /** worktree 模式:'group'=群共享一个 worktree(默认,轻量);'issue'=每 issue 独立(多分支并行)。null='group'。 */
  worktree_mode?: string | null
  /** 群类型: patrol=巡检群 / a2a_direct=单播群 / direct=单聊(2 人对话) / 未设置或空 = 普通群(chat)。 */
  type?: string | null
  member_count?: number
  /** 最近一条群消息时间;null=尚未发过消息。侧栏"对话列表"只展示有消息的群。 */
  last_message_at?: string | null
  members?: GroupMember[]
}

export interface GroupMember {
  agent_name: string
  joined_at: string
  /** Per-(group, agent) override; null = inherit from groups.working_dir. */
  working_dir: string | null
  /** Per-(group, agent) profile override JSON string ({position?,bio?,category?});
   *  null = no override, use agent's global profile. */
  profile: string | null
}

export interface CreateGroupDto {
  name: string
  memberNames?: string[]
  workingDir?: string
  type?: string
}

// Issue Types (task tracking)
export interface Issue {
  id: string
  group_id: string
  title: string
  description: string
  status: 'open' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused'
  priority: 'low' | 'medium' | 'high' | 'critical'
  created_by: string
  assigned_to: string | null
  working_dir: string | null
  result: string | null
  error_message: string | null
  artifacts: string
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  type: 'task'
  /** Slash command 声明（如 "/plan"）。由 master 端解析 title 前缀写入，UI 显示徽标。 */
  slash_command: string | null
  /** 工具调用审批策略。后端默认 .rw_allow.（写需人工审批，读放行）；
   *  'rw_allow' 时 worker 不传审批回调，写类工具也自动通过。
   *  老接口可能返回 undefined（迁移前的列），UI 读取处用 'rw_allow' 兜底。 */
  approval_policy?: 'r_allow' | 'rw_allow'
  /** Token usage JSON 字符串（migration 025）。解析为 TokenUsage 用于徽章展示。
   *  老接口可能返回 undefined（迁移前的列）。 */
  usage?: string | null
  /** Backend 报告的模型名（migration 025），如 `gpt-5` / `claude-sonnet-4-6`。 */
  model?: string | null
  /** 该 issue 执行时绑定的 CLI session_id（migration 013）。Debug Sessions
   *  视图里的 session 就是靠这个字段反查到对应 issue 的 usage。null 表示
   *  issue 还没开始执行 / 老数据 / 被 clear 掉。 */
  session_id?: string | null
  /** 该 issue 执行用的 CLI 后端(claude | codex | hermes | openclaw,migration 013)。 */
  cli_tool?: string | null
  /** 最新一次 TodoWrite 工具调用的 todos 快照(migration 028)。worker 解析
   *  Claude Code 的 TodoWrite tool_use 后通过 issue_todos_update WS 推送,
   *  master 落 issues.latest_todos_json,API 层解析为对象返回。undefined
   *  表示该 issue 还没上报过 todos(未开始 / 非 claude backend)。 */
  latest_todos?: TodoItem[]
}

/** TodoWrite 单条 todo。镜像后端 src/shared/protocol.ts 的 TodoItem 接口。
 *  activeForm 缺失时前端 fallback 到 content 渲染。 */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/** Token 用量信息。后端 TokenUsage interface 的前端镜像（见 src/executor/cli-executor.ts）。
 *  所有字段可选 —— 不同 backend（claude/codex/hermes）发射的字段子集不一样。 */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  totalCostUsd?: number
}

export interface IssueEvent {
  id: number
  issue_id: string
  event_type: string
  agent_name: string
  content: string
  metadata: string
  created_at: string
}

export interface CreateIssueDto {
  /** title 可选:未传时由后端从 description 截断生成 */
  title?: string
  description: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  createdBy: string
  workingDir?: string
}

// Note Types (极简文字记录,无执行流程)
export interface Note {
  id: string
  group_id: string
  title: string
  description: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface CreateNoteDto {
  title: string
  description?: string
  createdBy: string
}

// Scheduled Task Types (群内定时任务,后端 INTEGER ms 时间戳)
export interface Schedule {
  id: number
  name: string
  group_id: string
  mode: 'agent' | 'message'
  agent_name: string | null
  schedule_kind: 'once' | 'interval'
  interval_sec: number | null
  run_at: number | null
  prompt: string
  enabled: number
  next_run_at: number
  last_run_at: number | null
  last_status: 'ok' | 'error' | 'skipped' | null
  last_error: string | null
  last_issue_id: string | null
  repeat_times: number | null
  repeat_count: number
  created_at: number
  updated_at: number
  handler_key: string | null
  handler_payload: string | null
}

// Guidance Template Types (群指导 prompt 模板库)
// schedule_config 是 JSON 字符串,解析后形如 { mode, agent_name, schedule_kind, interval_sec, repeat_times, prompt }
// 其中 agent_name / prompt 也支持 {{teacher}}/{{student}}/{{topic}} 占位符。
export interface GuidanceTemplate {
  id: number
  name: string
  description: string
  prompt_text: string
  schedule_config: string | null
  sort_order: number
  is_default: number
  created_at: number
  updated_at: number
}

export interface GuidanceScheduleConfig {
  mode: 'agent' | 'message'
  agent_name?: string
  schedule_kind: 'once' | 'interval'
  interval_sec?: number
  run_at?: number
  repeat_times?: number
  prompt: string
}

// Schedule Pattern Types (调度模式参考库 — 常见定时任务模式样板)
// schedule_config 是 JSON 字符串,解析后形如 GuidanceScheduleConfig。
// 仅作参考/学习用,不直接管理 scheduled_tasks 实例。
export interface SchedulePattern {
  id: number
  name: string
  description: string
  schedule_config: string | null
  sort_order: number
  is_default: number
  created_at: number
  updated_at: number
}

// Artifact Types
export interface ArtifactFile {
  name: string
  path: string
  absPath?: string
  size: number
  modifiedTime: string
  type: 'file' | 'directory'
  children?: ArtifactFile[]
}

export interface ArtifactListing {
  root: string
  files: ArtifactFile[]
}

export interface ArtifactContent {
  path: string
  content: string
  size: number
  type: 'text' | 'binary'
}

export interface ArtifactOriginal {
  path: string
  base: string
  repoRoot: string | null
  relInRepo?: string
  content: string
  note?: string
}
