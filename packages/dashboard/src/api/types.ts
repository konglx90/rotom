// API Response Types
export interface ApiResponse<T> {
  data?: T
  error?: string
}

// Agent Profile
export interface AgentProfile {
  position?: string
  responsibilities?: string
  tech_stack?: string
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
  enabled: boolean
  last_heartbeat?: number
  connected_at?: number
  registered_at?: number
  profile?: AgentProfile
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
  member_count?: number
  members?: GroupMember[]
}

export interface GroupMember {
  agent_name: string
  joined_at: string
  /** Per-(group, agent) override; null = inherit from groups.working_dir. */
  working_dir: string | null
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
  // Collaboration fields
  type: 'task' | 'collaboration' | 'delivery' | 'review'
  collaboration_goal: string | null
  max_rounds: number | null
  current_round: number | null
  participants: string
  owner: string | null
  summary: string | null
  /** Slash command 声明（如 "/plan"）。由 master 端解析 title 前缀写入，UI 显示徽标。 */
  slash_command: string | null
  /** 工具调用审批策略。后端默认 'r_allow'（写需人工审批，读放行）；
   *  'rw_allow' 时 worker 不传审批回调，写类工具也自动通过。
   *  老接口可能返回 undefined（迁移前的列），UI 读取处用 'r_allow' 兜底。 */
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

export interface CreateCollaborationDto {
  title: string
  collaborationGoal: string
  participants: string[]
  maxRounds: number
  owner?: string
  createdBy: string
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
