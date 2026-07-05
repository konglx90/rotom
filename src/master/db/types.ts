/**
 * Row type definitions for the mesh SQLite database.
 *
 * Each interface mirrors the SQLite column names exactly — the runtime
 * layer in `db/internal.ts` maps SELECT results onto these types.
 *
 * Kept in its own module so consumers (api/, executor/worker.ts, tests,
 * dashboard) can import row types without dragging in better-sqlite3.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Row types — match SQLite column names exactly
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  owner: string | null;
  status: string;
  instance_id: string | null;
  hostname: string | null;
  platform: string | null;
  endpoint: string | null;
  version: string | null;
  last_heartbeat: string | null;
  connected_at: string | null;
  registered_at: string;
  updated_at: string;
  token_hash: string | null;
  token: string | null;
  enabled: number;
  profile: string | null;
  avatar_url: string | null;
}

export interface OfflineMessageRow {
  id: number;
  target_agent: string;
  from_name: string;
  from_domain: string | null;
  payload: string;
  route_type: string | null;
  created_at: string;
  expires_at: string | null;
  /** 057 加:跨 master 投递时的目标 hostname(display,可改);本地 agent 离线队列为 NULL */
  target_hostname?: string | null;
  /** 057 加:跨 master 投递时来源 member 的 masterId;本地 agent 离线队列为 NULL */
  source_master_id?: string | null;
  /** 059 加:跨 master 投递时目标 member 的 masterId(稳定主键);本地 agent 离线队列为 NULL */
  target_master_id?: string | null;
}

export interface AuditLogRow {
  id: number;
  timestamp: string;
  from_name: string | null;
  from_domain: string | null;
  to_name: string | null;
  to_domain: string | null;
  route_type: string | null;
  result: string;
  message_summary: string | null;
}

export interface MessageLogRow {
  id: number;
  request_id: string;
  timestamp: string;
  from_name: string;
  from_domain: string | null;
  to_name: string | null;
  to_domain: string | null;
  route_type: string | null;
  direction: string;
  payload: string;
  status: string;
  latency_ms: number | null;
  group_id: string | null;
  source: string | null;
}

export interface DomainRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

/**
 * master_node 表的行类型 —— 单行表,存本机 master 的身份(masterId、hostname、role、teamName)。
 * masterId 是 8 字符 base36,首次启动由 OPC bootstrap 生成、永远稳定。
 * hostname 仅作显示用,可改;role 在 Phase 1 永远 standalone。
 * team_name 是人取的团队展示名(如"西花团队"),默认 = hostname,可改。
 */
export interface MasterNodeRow {
  id: string;
  hostname: string;
  role: "standalone" | "coordination" | "member";
  display_name: string | null;
  endpoint: string | null;
  federation_enabled: number;
  team_name: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Federation (migration 056 + 058 rename) ──────────────────────────────

/** team 行 —— 本机 master 加入的团队(每行一个团队) */
export interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  /** 本机在此团队里的角色:coordination(我是协调)/ member(我接入) */
  my_role: "coordination" | "member";
  /** 逗号分隔的协调 master ws endpoint 列表 */
  coord_endpoints: string;
  joined_at: string;
}

/** team_peers 行 —— 团队内其他 master(协调侧权威,member 侧缓存) */
export interface TeamPeerRow {
  team_id: string;
  master_id: string;
  hostname: string;
  endpoint: string | null;
  role: "coordination" | "member";
  last_seen_at: string | null;
}

/**
 * agent_visibility 行 —— 跨 master 可见的 agent 发布记录。
 * 协调侧权威,member 侧缓存。PK 用 master_id 而非 hostname(hostname 只是 display)。
 */
export interface AgentVisibilityRow {
  team_id: string;
  master_id: string;
  agent_name: string;
  hostname: string;
  display_name: string | null;
  is_human: number;
  online: number;
  last_heartbeat: string | null;
}

/** human_membership 行 —— 真人加入哪些团队 */
export interface HumanMembershipRow {
  agent_id: string;
  team_id: string;
  joined_at: string;
}

export interface IssueRow {
  id: string;
  group_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  created_by: string;
  assigned_to: string | null;
  working_dir: string | null;
  result: string | null;
  error_message: string | null;
  artifacts: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  type: string;
  // Session continuation (added in migration 013)
  session_id: string | null;
  cli_tool: string | null;
  // Slash command (added in migration 014). 例如 '/plan'，由 master 端解析 title 写入。
  slash_command: string | null;
  // 审批策略 (added in migration 015)。
  //   'rw_allow' (默认) → claude 不挂 PreToolUse hook; codex 不传 onApprovalRequest, 写盘直接放行
  //   'r_allow'           → 写类工具调用走人工审批, 读类放行
  approval_policy: string;
  // Session usage / model (added in migration 025)。usage 是 TokenUsage 的
  //   'rw_allow' (默认) → 写类工具调用直接放行，无需人工审批
  usage: string | null;
  model: string | null;
  // 最新一次 TodoWrite 的 todos 快照(added in migration 028)。JSON 字符串,
  // 形如 [{"content":"...","status":"pending|in_progress|completed","activeForm":"..."}]。
  // 由 worker 收到 issue_todos_update 后覆盖式写入,dashboard 常驻面板读它。
  latest_todos_json: string | null;
  // 内置 repo(migration 051):issue 级覆盖。NULL = 沿用 group 的 repo_url。
  repo_url: string | null;
  // issue 级分支覆盖。NULL = 沿用 group 的 repo_default_branch 或临时分支。
  repo_branch: string | null;
}

export interface IssueEventRow {
  id: number;
  issue_id: string;
  event_type: string;
  agent_name: string;
  content: string;
  metadata: string;
  created_at: string;
  /** ID of the event/comment this is replying to (for message quoting) */
  reply_to_id: number | null;
}

export interface NoteRow {
  id: string;
  group_id: string;
  title: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Scheduled tasks (群内定时任务)
// 时间戳全部是 INTEGER ms (Unix epoch),由调度器进程维护 next_run_at。
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduledTaskRow {
  id: number;
  name: string;
  group_id: string;
  mode: "agent" | "message";
  agent_name: string | null;
  schedule_kind: "once" | "interval";
  interval_sec: number | null;
  run_at: number | null;
  prompt: string;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  last_status: "ok" | "error" | "skipped" | null;
  last_error: string | null;
  last_issue_id: string | null;
  repeat_times: number | null;
  repeat_count: number;
  created_at: number;
  updated_at: number;
  /** 非空时,task 到点跑 handler_key 对应的硬编码逻辑(而非 prompt/agent)。 */
  handler_key: string | null;
  /** JSON 字符串,handler 自行解析。 */
  handler_payload: string | null;
}

/** ask_bridges 行 —— Agent A 提问 B 后的等回复 + 超时兜底记录。详见 migration 034。 */
export interface AskBridgeRow {
  id: string;
  group_id: string;
  asker: string;
  target: string;
  question_msg_id: number;
  escalate_to: string | null;
  timeout_ms: number;
  created_at: number;
  expires_at: number;
  status: "pending" | "answered" | "timed_out" | "cancelled";
  reply_msg_id: number | null;
  resolved_at: number | null;
  issue_id: string | null;
}