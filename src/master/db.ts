/**
 * Digital Employee Mesh — Database layer (better-sqlite3)
 *
 * Pure data access — no business logic. WAL mode for concurrent reads.
 * All row types are explicitly typed (no `as any`).
 */

import type BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_RETENTION_DAYS } from "../shared/constants.js";

// Dynamic import: better-sqlite3 is optionalDependency (only needed for Master)
let Database: typeof BetterSqlite3;
try {
  Database = (await import("better-sqlite3")).default;
} catch {
  // Will remain undefined — MeshDb constructor will throw a clear error
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  // Collaboration fields
  type: string;
  collaboration_goal: string | null;
  max_rounds: number | null;
  current_round: number | null;
  participants: string;
  owner: string | null;
  summary: string | null;
  // Session continuation (added in migration 013)
  session_id: string | null;
  cli_tool: string | null;
  // Slash command (added in migration 014). 例如 '/plan'，由 master 端解析 title 写入。
  slash_command: string | null;
  // 审批策略 (added in migration 015)。
  //   'r_allow'  (默认) → 写类工具调用走人工审批，读类放行
  //   'rw_allow'         → claude 不挂 PreToolUse hook；codex 不传 onApprovalRequest
  approval_policy: string;
  // Session usage / model (added in migration 025)。usage 是 TokenUsage 的
  // JSON 字符串(见 src/executor/cli-executor.ts),由 worker 透传过来。
  usage: string | null;
  model: string | null;
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
}

// ═══════════════════════════════════════════════════════════════════════════
// MeshDb
// ═══════════════════════════════════════════════════════════════════════════

export class MeshDb {
  private db: BetterSqlite3.Database;
  /** Hook fired when an issue transitions to a terminal state. */
  _onIssueTerminal?: (issueId: string) => void;

  constructor(dbPath: string) {
    if (!Database) {
      throw new Error(
        "better-sqlite3 is required for Master mode but not installed.\n" +
        "Run: pnpm install better-sqlite3   (or npm install better-sqlite3)",
      );
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Migration with version tracking
  // ═══════════════════════════════════════════════════════════════════════════

  private migrate(): void {
    // Ensure version tracking table exists (bootstrap — always safe to run)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Find applied versions
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_version").all() as { version: number }[])
        .map(r => r.version),
    );

    // Resolve migration directory
    let migDir = path.resolve(__dirname, "../../../migrations");
    if (!fs.existsSync(migDir)) {
      migDir = path.resolve(__dirname, "../../migrations");
    }

    // Run unapplied .sql files in order
    const files = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      // Extract version number from filename: "001-init.sql" → 1
      const match = file.match(/^(\d+)/);
      if (!match) continue;
      const version = parseInt(match[1], 10);

      if (applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(migDir, file), "utf-8");
      this.db.exec(sql);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    }

    // Inline migration: add endpoint column if missing (safe to re-run)
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN endpoint TEXT");
    } catch {
      // Column already exists — ignore
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Agent CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  getAgentByName(name: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  }

  getAgentById(id: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  }

  /** Lookup agent by token hash — used as fallback when name changes but token stays the same. */
  getAgentByTokenHash(tokenHash: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(tokenHash) as AgentRow | undefined;
  }

  /** Update agent name (used when agent reconnects with a new name but same token). */
  updateAgentName(id: string, name: string): void {
    this.db.prepare(
      "UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(name, id);
  }

  listAgents(filter?: { status?: string; domain?: string; enabled?: boolean }): AgentRow[] {
    let sql = "SELECT * FROM agents WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.domain) {
      sql += " AND domain = ?";
      params.push(filter.domain);
    }
    if (filter?.enabled !== undefined) {
      sql += " AND enabled = ?";
      params.push(filter.enabled ? 1 : 0);
    }
    sql += " ORDER BY name";
    return this.db.prepare(sql).all(...params) as AgentRow[];
  }

  insertAgent(agent: {
    id: string;
    name: string;
    description?: string;
    domain?: string;
    tokenHash: string;
    token: string;
    profile?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO agents (id, name, description, domain, token_hash, token, profile)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.name,
      agent.description || null,
      agent.domain || null,
      agent.tokenHash,
      agent.token,
      agent.profile || null,
    );
  }

  updateAgentMeta(id: string, meta: { description?: string; domain?: string; profile?: string }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (meta.description !== undefined) { sets.push("description = ?"); values.push(meta.description); }
    if (meta.domain !== undefined) { sets.push("domain = ?"); values.push(meta.domain); }
    if (meta.profile !== undefined) { sets.push("profile = ?"); values.push(meta.profile); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  updateAgentEnabled(id: string, enabled: boolean): void {
    this.db.prepare(
      "UPDATE agents SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(enabled ? 1 : 0, id);
  }

  setAgentOnline(id: string, instance?: { instanceId?: string; hostname?: string; platform?: string; endpoint?: string; version?: string }): void {
    this.db.prepare(`
      UPDATE agents SET
        status = 'online',
        instance_id = ?,
        hostname = ?,
        platform = ?,
        endpoint = ?,
        version = ?,
        connected_at = datetime('now'),
        last_heartbeat = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      instance?.instanceId || null,
      instance?.hostname || null,
      instance?.platform || null,
      instance?.endpoint || null,
      instance?.version || null,
      id,
    );
  }

  setAgentOffline(id: string): void {
    this.db.prepare(
      "UPDATE agents SET status = 'offline', updated_at = datetime('now') WHERE id = ?",
    ).run(id);
  }

  /** Reset all agents to offline — called on Master startup to clear stale state. */
  resetAllOnline(): number {
    const result = this.db.prepare(
      "UPDATE agents SET status = 'offline', updated_at = datetime('now') WHERE status = 'online'",
    ).run();
    return result.changes;
  }

  updateAgentToken(id: string, tokenHash: string, token: string): void {
    this.db.prepare(
      "UPDATE agents SET token_hash = ?, token = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(tokenHash, token, id);
    // Record token refresh timestamp for JWT iat validation
    this.setConfig(`token_refreshed_at:${id}`, new Date().toISOString());
  }

  /** Get the timestamp when an agent's token was last refreshed. */
  getTokenRefreshedAt(id: string): string | undefined {
    return this.getConfig(`token_refreshed_at:${id}`);
  }

  updateHeartbeat(id: string): void {
    this.db.prepare(
      "UPDATE agents SET last_heartbeat = datetime('now') WHERE id = ?",
    ).run(id);
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM offline_messages WHERE target_agent = ?").run(id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Offline messages
  // ═══════════════════════════════════════════════════════════════════════════

  enqueueOffline(
    targetAgent: string,
    fromName: string,
    fromDomain: string | undefined,
    payload: string,
    routeType: string,
  ): boolean {
    // Purge expired
    this.db.prepare("DELETE FROM offline_messages WHERE expires_at < datetime('now')").run();

    // Check per-agent limit
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM offline_messages WHERE target_agent = ?",
    ).get(targetAgent) as { c: number };
    if (row.c >= 100) return false;

    // Verify target agent exists
    const agent = this.getAgentById(targetAgent);
    if (!agent) return false;

    this.db.prepare(`
      INSERT INTO offline_messages (target_agent, from_name, from_domain, payload, route_type, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'))
    `).run(targetAgent, fromName, fromDomain || "", payload, routeType);
    return true;
  }

  popOffline(targetAgent: string): OfflineMessageRow[] {
    const msgs = this.db.prepare(
      "SELECT * FROM offline_messages WHERE target_agent = ? AND expires_at > datetime('now') ORDER BY created_at",
    ).all(targetAgent) as OfflineMessageRow[];

    if (msgs.length > 0) {
      this.db.prepare("DELETE FROM offline_messages WHERE target_agent = ?").run(targetAgent);
    }
    return msgs;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Audit
  // ═══════════════════════════════════════════════════════════════════════════

  audit(entry: {
    fromName?: string;
    fromDomain?: string;
    toName?: string;
    toDomain?: string;
    routeType?: string;
    result: string;
    messageSummary?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO audit_log (from_name, from_domain, to_name, to_domain, route_type, result, message_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.fromName || null,
      entry.fromDomain || null,
      entry.toName || null,
      entry.toDomain || null,
      entry.routeType || null,
      entry.result,
      entry.messageSummary?.slice(0, 100) || null,
    );
  }

  listAudit(limit: number = 50): AuditLogRow[] {
    return this.db.prepare(
      "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?",
    ).all(limit) as AuditLogRow[];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Domains
  // ═══════════════════════════════════════════════════════════════════════════

  listDomains(): DomainRow[] {
    return this.db.prepare("SELECT * FROM domains ORDER BY name").all() as DomainRow[];
  }

  getDomainByName(name: string): DomainRow | undefined {
    return this.db.prepare("SELECT * FROM domains WHERE name = ?").get(name) as DomainRow | undefined;
  }

  getDomainById(id: string): DomainRow | undefined {
    return this.db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as DomainRow | undefined;
  }

  insertDomain(id: string, name: string, description?: string): void {
    this.db.prepare(
      "INSERT INTO domains (id, name, description) VALUES (?, ?, ?)",
    ).run(id, name, description || null);
  }

  updateDomain(id: string, meta: { name?: string; description?: string }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (meta.name !== undefined) { sets.push("name = ?"); values.push(meta.name); }
    if (meta.description !== undefined) { sets.push("description = ?"); values.push(meta.description); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteDomain(id: string): void {
    this.db.prepare("DELETE FROM domains WHERE id = ?").run(id);
  }

  /** Rename domain in all agents (used when domain name changes). */
  renameDomainInAgents(oldName: string, newName: string): void {
    this.db.prepare(
      "UPDATE agents SET domain = ?, updated_at = datetime('now') WHERE domain = ?",
    ).run(newName, oldName);
    // Also update cross_domain_rules
    this.db.prepare("UPDATE cross_domain_rules SET from_domain = ? WHERE from_domain = ?").run(newName, oldName);
    this.db.prepare("UPDATE cross_domain_rules SET to_domain = ? WHERE to_domain = ?").run(newName, oldName);
  }

  /** Count agents belonging to a domain (by domain name). */
  countAgentsByDomain(domainName: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE domain = ?",
    ).get(domainName) as { c: number };
    return row.c;
  }

  canCrossDomain(from: string | undefined, to: string | undefined): boolean {
    // No domain set → no isolation
    if (!from || !to) return true;
    // Same domain → always OK
    if (from === to) return true;
    // Check explicit rule
    return !!this.db.prepare(
      "SELECT 1 FROM cross_domain_rules WHERE from_domain = ? AND to_domain = ?",
    ).get(from, to);
  }

  /** Add cross-domain rule. Set bidirectional=true to create both A→B and B→A. */
  addCrossDomainRule(from: string, to: string, bidirectional = false): void {
    this.db.prepare("INSERT OR IGNORE INTO cross_domain_rules (from_domain, to_domain) VALUES (?, ?)").run(from, to);
    if (bidirectional) {
      this.db.prepare("INSERT OR IGNORE INTO cross_domain_rules (from_domain, to_domain) VALUES (?, ?)").run(to, from);
    }
  }

  /** List all cross-domain rules. */
  listCrossDomainRules(): { from_domain: string; to_domain: string }[] {
    return this.db.prepare("SELECT from_domain, to_domain FROM cross_domain_rules ORDER BY from_domain, to_domain").all() as { from_domain: string; to_domain: string }[];
  }

  /** Count cross-domain rules referencing a domain (as source or target). */
  countCrossDomainRulesByDomain(domainName: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM cross_domain_rules WHERE from_domain = ? OR to_domain = ?",
    ).get(domainName, domainName) as { c: number };
    return row.c;
  }

  /** Delete a cross-domain rule. */
  deleteCrossDomainRule(from: string, to: string): boolean {
    const result = this.db.prepare("DELETE FROM cross_domain_rules WHERE from_domain = ? AND to_domain = ?").run(from, to);
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════════════════════════════════════

  getConfig(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Message log (for dashboard conversations)
  // ═══════════════════════════════════════════════════════════════════════════

  logMessage(entry: {
    requestId: string;
    fromName: string;
    fromDomain?: string;
    toName?: string;
    toDomain?: string;
    routeType?: string;
    direction: "send" | "reply";
    payload: string;
    status: string;
    latencyMs?: number;
    groupId?: string;
    source?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO message_log (request_id, from_name, from_domain, to_name, to_domain, route_type, direction, payload, status, latency_ms, group_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.requestId,
      entry.fromName,
      entry.fromDomain || null,
      entry.toName || null,
      entry.toDomain || null,
      entry.routeType || null,
      entry.direction,
      entry.payload,
      entry.status,
      entry.latencyMs ?? null,
      entry.groupId || null,
      entry.source || null,
    );
  }

  listMessages(opts?: {
    agent?: string;
    from?: string;
    to?: string;
    status?: string;
    keyword?: string;
    groupId?: string;
    limit?: number;
    offset?: number;
    before?: string;
  }): MessageLogRow[] {
    let sql = "SELECT * FROM message_log WHERE 1=1";
    const params: unknown[] = [];
    if (opts?.agent) {
      sql += " AND (from_name = ? OR to_name = ?)";
      params.push(opts.agent, opts.agent);
    }
    if (opts?.from) {
      sql += " AND from_name = ?";
      params.push(opts.from);
    }
    if (opts?.to) {
      sql += " AND to_name = ?";
      params.push(opts.to);
    }
    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    if (opts?.groupId) {
      sql += " AND group_id = ?";
      params.push(opts.groupId);
    }
    if (opts?.keyword) {
      sql += " AND payload LIKE ?";
      params.push(`%${opts.keyword}%`);
    }
    if (opts?.before) {
      sql += " AND timestamp < ?";
      params.push(opts.before);
    }
    sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    params.push(Math.min(opts?.limit || 100, 500));
    params.push(Math.max(opts?.offset || 0, 0));
    return this.db.prepare(sql).all(...params) as MessageLogRow[];
  }

  countMessages(opts?: {
    agent?: string;
    from?: string;
    to?: string;
    status?: string;
    keyword?: string;
    groupId?: string;
    before?: string;
  }): number {
    let sql = "SELECT COUNT(*) as total FROM message_log WHERE 1=1";
    const params: unknown[] = [];
    if (opts?.agent) {
      sql += " AND (from_name = ? OR to_name = ?)";
      params.push(opts.agent, opts.agent);
    }
    if (opts?.from) {
      sql += " AND from_name = ?";
      params.push(opts.from);
    }
    if (opts?.to) {
      sql += " AND to_name = ?";
      params.push(opts.to);
    }
    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    if (opts?.groupId) {
      sql += " AND group_id = ?";
      params.push(opts.groupId);
    }
    if (opts?.keyword) {
      sql += " AND payload LIKE ?";
      params.push(`%${opts.keyword}%`);
    }
    if (opts?.before) {
      sql += " AND timestamp < ?";
      params.push(opts.before);
    }
    return (this.db.prepare(sql).get(...params) as { total: number }).total;
  }

  /** Per-agent message stats */
  agentMessageStats(): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT
        name,
        (SELECT COUNT(*) FROM message_log WHERE to_name = agents.name AND direction = 'send') as received,
        (SELECT COUNT(*) FROM message_log WHERE from_name = agents.name AND direction = 'send') as sent,
        (SELECT COUNT(*) FROM message_log WHERE to_name = agents.name AND direction = 'reply') as replied,
        (SELECT COUNT(*) FROM message_log WHERE (from_name = agents.name OR to_name = agents.name) AND status = 'failed') as failed,
        (SELECT AVG(latency_ms) FROM message_log WHERE to_name = agents.name AND direction = 'reply' AND latency_ms IS NOT NULL) as avg_latency_ms
      FROM agents
      ORDER BY name
    `).all() as Record<string, unknown>[];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Log cleanup — prevents unbounded table growth
  // ═══════════════════════════════════════════════════════════════════════════

  /** Delete audit_log and message_log entries older than retention period. */
  cleanupOldLogs(retentionDays: number = LOG_RETENTION_DAYS): { auditDeleted: number; messageDeleted: number } {
    const auditResult = this.db.prepare(
      "DELETE FROM audit_log WHERE timestamp < datetime('now', ? || ' days')",
    ).run(`-${retentionDays}`);
    const messageResult = this.db.prepare(
      "DELETE FROM message_log WHERE timestamp < datetime('now', ? || ' days')",
    ).run(`-${retentionDays}`);
    return {
      auditDeleted: auditResult.changes,
      messageDeleted: messageResult.changes,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════════════════════════

  stats(): { total: number; online: number; domains: number } {
    const agents = this.listAgents();
    return {
      total: agents.length,
      online: agents.filter(a => a.status === "online").length,
      domains: (this.db.prepare(
        "SELECT COUNT(DISTINCT domain) as c FROM agents WHERE domain IS NOT NULL AND domain != ''",
      ).get() as { c: number }).c,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Groups
  // ═══════════════════════════════════════════════════════════════════════════

  createGroup(id: string, name: string, createdBy?: string, workingDir?: string): void {
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, working_dir) VALUES (?, ?, ?, ?)",
    ).run(id, name, createdBy || null, workingDir || null);
  }

  updateGroupWorkingDir(id: string, workingDir: string | null): void {
    this.db.prepare("UPDATE groups SET working_dir = ? WHERE id = ?")
      .run(workingDir, id);
  }

  updateGroupName(id: string, name: string): void {
    this.db.prepare("UPDATE groups SET name = ? WHERE id = ?")
      .run(name, id);
  }

  /**
   * Toggle (or set explicitly) the per-group pinned_at timestamp.
   * Passing `null` unpins; passing a value pins to "now" (UTC string).
   */
  updateGroupPinned(id: string, pinned: boolean): string | null {
    const next = pinned ? new Date().toISOString() : null;
    this.db.prepare("UPDATE groups SET pinned_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  }

  /**
   * Archive or unarchive a group. Archived groups are read-only: no new messages,
   * issues, or collaboration. Passing `true` sets archived_at to "now";
   * passing `false` clears it.
   */
  updateGroupArchived(id: string, archived: boolean): string | null {
    const next = archived ? new Date().toISOString() : null;
    this.db.prepare("UPDATE groups SET archived_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  }

  /**
   * Returns the archived_at value of a group, or null if not archived.
   */
  isGroupArchived(id: string): string | null {
    const row = this.db.prepare("SELECT archived_at FROM groups WHERE id = ?").get(id) as { archived_at: string | null } | undefined;
    return row?.archived_at ?? null;
  }

  /**
   * Backfill working_dir on legacy groups (NULL or empty). Caller supplies the
   * `compute` fn — kept out of db.ts so this module stays free of filesystem
   * conventions (homedir, ARTIFACTS_ROOT, etc.). Returns the list of (id, path)
   * pairs that were written, so the caller can mkdir each one.
   */
  backfillGroupDefaultWorkingDir(
    compute: (id: string) => string,
  ): { id: string; workingDir: string }[] {
    const rows = this.db.prepare(
      "SELECT id FROM groups WHERE working_dir IS NULL OR working_dir = ''",
    ).all() as { id: string }[];
    if (rows.length === 0) return [];
    const update = this.db.prepare("UPDATE groups SET working_dir = ? WHERE id = ?");
    const filled: { id: string; workingDir: string }[] = [];
    const tx = this.db.transaction((items: { id: string }[]) => {
      for (const { id } of items) {
        const wd = compute(id);
        update.run(wd, id);
        filled.push({ id, workingDir: wd });
      }
    });
    tx(rows);
    return filled;
  }

  listGroups(): { id: string; name: string; created_by: string | null; created_at: string; working_dir: string | null; pinned_at: string | null; archived_at: string | null; member_count: number }[] {
    return this.db.prepare(`
      SELECT g.*, COUNT(gm.agent_name) as member_count
      FROM groups g
      LEFT JOIN group_members gm ON g.id = gm.group_id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `).all() as { id: string; name: string; created_by: string | null; created_at: string; working_dir: string | null; pinned_at: string | null; archived_at: string | null; member_count: number }[];
  }

  listGroupsWithMembers(): { id: string; name: string; created_by: string | null; created_at: string; working_dir: string | null; pinned_at: string | null; archived_at: string | null; member_count: number; members: { agent_name: string; joined_at: string; working_dir: string | null }[] }[] {
    const groups = this.listGroups();
    const rows = this.db.prepare(`
      SELECT gm.group_id, gm.agent_name, gm.joined_at, gms.working_dir
      FROM group_members gm
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      ORDER BY gm.joined_at
    `).all() as { group_id: string; agent_name: string; joined_at: string; working_dir: string | null }[];
    const byGroup = new Map<string, { agent_name: string; joined_at: string; working_dir: string | null }[]>();
    for (const r of rows) {
      let list = byGroup.get(r.group_id);
      if (!list) {
        list = [];
        byGroup.set(r.group_id, list);
      }
      list.push({ agent_name: r.agent_name, joined_at: r.joined_at, working_dir: r.working_dir });
    }
    return groups.map((g) => ({ ...g, members: byGroup.get(g.id) ?? [] }));
  }

  getGroupById(id: string): { id: string; name: string; created_by: string | null; created_at: string; working_dir: string | null; pinned_at: string | null; archived_at: string | null; type: string | null; metadata: string } | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as { id: string; name: string; created_by: string | null; created_at: string; working_dir: string | null; pinned_at: string | null; archived_at: string | null; type: string | null; metadata: string } | undefined;
  }

  deleteGroup(id: string): void {
    this.db.prepare("DELETE FROM group_messages WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM group_member_settings WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  }

  /** Create group with type and metadata (for e2ed integration) */
  createGroupTyped(opts: {
    id: string;
    name: string;
    type: string;
    createdBy?: string;
    workingDir?: string | null;
    metadata?: string;
  }): void {
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, working_dir, type, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(opts.id, opts.name, opts.createdBy || null, opts.workingDir || null, opts.type, opts.metadata || '{}');
  }

  /** Get group by id including type and metadata columns */
  getGroupByIdFull(id: string): {
    id: string; name: string; created_by: string | null; created_at: string;
    working_dir: string | null; pinned_at: string | null; archived_at: string | null;
    type: string | null; metadata: string;
  } | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as any;
  }

  /** List groups filtered by type */
  listGroupsByType(type: string): Array<{
    id: string; name: string; created_by: string | null; created_at: string;
    working_dir: string | null; type: string | null; metadata: string;
  }> {
    return this.db.prepare(
      "SELECT id, name, created_by, created_at, working_dir, type, metadata FROM groups WHERE type = ? ORDER BY created_at DESC",
    ).all(type) as any[];
  }

  /** Update group metadata JSON */
  updateGroupMetadata(id: string, metadata: string): void {
    this.db.prepare("UPDATE groups SET metadata = ? WHERE id = ?").run(metadata, id);
  }

  addGroupMembers(groupId: string, agentNames: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO group_members (group_id, agent_name) VALUES (?, ?)",
    );
    for (const name of agentNames) {
      stmt.run(groupId, name);
    }
  }

  removeGroupMembers(groupId: string, agentNames: string[]): void {
    const tx = this.db.transaction((names: string[]) => {
      const m = this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND agent_name = ?");
      const s = this.db.prepare("DELETE FROM group_member_settings WHERE group_id = ? AND agent_name = ?");
      for (const name of names) {
        m.run(groupId, name);
        s.run(groupId, name);
      }
    });
    tx(agentNames);
  }

  getGroupMembers(groupId: string): { agent_name: string; joined_at: string; working_dir: string | null }[] {
    return this.db.prepare(`
      SELECT gm.agent_name, gm.joined_at, gms.working_dir
      FROM group_members gm
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at
    `).all(groupId) as { agent_name: string; joined_at: string; working_dir: string | null }[];
  }

  getGroupMemberSetting(groupId: string, agentName: string): string | null {
    const row = this.db.prepare(
      "SELECT working_dir FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).get(groupId, agentName) as { working_dir: string } | undefined;
    return row?.working_dir ?? null;
  }

  listGroupMemberSettings(groupId: string): { agent_name: string; working_dir: string; updated_at: string }[] {
    return this.db.prepare(
      "SELECT agent_name, working_dir, updated_at FROM group_member_settings WHERE group_id = ? ORDER BY agent_name",
    ).all(groupId) as { agent_name: string; working_dir: string; updated_at: string }[];
  }

  upsertGroupMemberSetting(groupId: string, agentName: string, workingDir: string): void {
    this.db.prepare(`
      INSERT INTO group_member_settings (group_id, agent_name, working_dir, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, agent_name) DO UPDATE SET
        working_dir = excluded.working_dir,
        updated_at  = excluded.updated_at
    `).run(groupId, agentName, workingDir, new Date().toISOString());
  }

  clearGroupMemberSetting(groupId: string, agentName: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).run(groupId, agentName);
    return result.changes > 0;
  }

  addGroupMessage(
    groupId: string,
    sender: string,
    content: string,
    mentions: string[] = [],
    options?: { cancelledAt?: string },
  ): number {
    const result = this.db.prepare(
      "INSERT INTO group_messages (group_id, sender, content, mentions, cancelled_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      groupId,
      sender,
      content,
      JSON.stringify(mentions),
      options?.cancelledAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * 把 worker 算出的 ComposedPrompt 持久化到 chat_message_prompts,keyed by
   * group_messages.id。Dashboard 点击消息时读这张表渲染分层组成。
   */
  addChatMessagePrompt(
    groupMessageId: number,
    layersJson: string,
    final: string,
    generatedAt: string,
    promptVersion: string,
  ): void {
    this.db.prepare(
      `INSERT INTO chat_message_prompts (group_message_id, layers, final, generated_at, prompt_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(groupMessageId, layersJson, final, generatedAt, promptVersion);
  }

  getChatMessagePrompt(groupMessageId: number): {
    layers: { layer: string; content: string; source: string }[];
    final: string;
    generated_at: string;
    prompt_version: string;
  } | null {
    const row = this.db.prepare(
      `SELECT layers, final, generated_at, prompt_version
       FROM chat_message_prompts WHERE group_message_id = ?`,
    ).get(groupMessageId) as { layers: string; final: string; generated_at: string; prompt_version: string } | undefined;
    if (!row) return null;
    return {
      layers: JSON.parse(row.layers),
      final: row.final,
      generated_at: row.generated_at,
      prompt_version: row.prompt_version,
    };
  }

  getGroupMessages(groupId: string, limit = 200): {
    id: number; sender: string; content: string; mentions: string; created_at: string;
    cancelled_at: string | null;
    composed_prompt: {
      layers: { layer: string; content: string; source: string }[];
      final: string;
      generated_at: string;
      prompt_version: string;
    } | null;
  }[] {
    const rows = this.db.prepare(
      `SELECT m.id, m.sender, m.content, m.mentions, m.created_at, m.cancelled_at,
              p.layers, p.final, p.generated_at, p.prompt_version
       FROM group_messages m
       LEFT JOIN chat_message_prompts p ON p.group_message_id = m.id
       WHERE m.group_id = ?
       ORDER BY m.created_at ASC
       LIMIT ?`,
    ).all(groupId, limit) as Array<{
      id: number; sender: string; content: string; mentions: string; created_at: string;
      cancelled_at: string | null;
      layers: string | null; final: string | null; generated_at: string | null; prompt_version: string | null;
    }>;
    return rows.map((r) => {
      let composed_prompt: {
        layers: { layer: string; content: string; source: string }[];
        final: string; generated_at: string; prompt_version: string;
      } | null = null;
      if (r.layers && r.final && r.generated_at && r.prompt_version) {
        composed_prompt = {
          layers: JSON.parse(r.layers),
          final: r.final,
          generated_at: r.generated_at,
          prompt_version: r.prompt_version,
        };
      }
      return {
        id: r.id, sender: r.sender, content: r.content, mentions: r.mentions, created_at: r.created_at,
        cancelled_at: r.cancelled_at,
        composed_prompt,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Issues (task tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  createIssue(issue: {
    id: string; groupId: string; title: string; description?: string;
    priority?: string; createdBy: string; workingDir?: string;
    slashCommand?: string;
    approvalPolicy?: "r_allow" | "rw_allow";
    type?: string; assignedTo?: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO issues (id, group_id, title, description, priority, created_by, working_dir, type, slash_command, approval_policy, assigned_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issue.id, issue.groupId, issue.title,
      issue.description || "", issue.priority || "medium",
      issue.createdBy, issue.workingDir || null,
      issue.type || "task",
      issue.slashCommand || null,
      issue.approvalPolicy || "r_allow",
      issue.assignedTo || null,
      now,
    );
    this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, created_at)
      VALUES (?, 'created', ?, '', ?)
    `).run(issue.id, issue.createdBy, now);
  }

  getIssueById(id: string): IssueRow | undefined {
    return this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  }

  listIssuesByGroup(groupId: string, status?: string, type?: string): IssueRow[] {
    let sql = "SELECT * FROM issues WHERE group_id = ?";
    const params: unknown[] = [groupId];
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (type) { sql += " AND type = ?"; params.push(type); }
    sql += " ORDER BY created_at DESC";
    return this.db.prepare(sql).all(...params) as IssueRow[];
  }

  listAllIssues(status?: string): IssueRow[] {
    let sql = "SELECT * FROM issues";
    const params: unknown[] = [];
    if (status) { sql += " WHERE status = ?"; params.push(status); }
    sql += " ORDER BY created_at DESC";
    return this.db.prepare(sql).all(...params) as IssueRow[];
  }

  updateIssueStatus(id: string, status: string, extra?: {
    assignedTo?: string | null;
    result?: string | null;
    errorMessage?: string | null;
    artifacts?: string[];
    /** Update session_id (added in migration 013). `null` clears it. */
    sessionId?: string | null;
    /** Update cli_tool (added in migration 013). `null` clears it. */
    cliTool?: string | null;
    /** Token usage JSON string (added in migration 025). `null` clears it. */
    usage?: string | null;
    /** Model name the backend reported (added in migration 025). */
    model?: string | null;
  }): void {
    const now = new Date().toISOString();
    const sets: string[] = ["status = ?", "updated_at = ?"];
    const values: unknown[] = [status, now];
    if (extra?.assignedTo !== undefined) { sets.push("assigned_to = ?"); values.push(extra.assignedTo); }
    if (extra?.result !== undefined) { sets.push("result = ?"); values.push(extra.result); }
    if (extra?.errorMessage !== undefined) { sets.push("error_message = ?"); values.push(extra.errorMessage); }
    if (extra?.artifacts !== undefined) { sets.push("artifacts = ?"); values.push(JSON.stringify(extra.artifacts)); }
    if (extra?.sessionId !== undefined) { sets.push("session_id = ?"); values.push(extra.sessionId); }
    if (extra?.cliTool !== undefined) { sets.push("cli_tool = ?"); values.push(extra.cliTool); }
    if (extra?.usage !== undefined) { sets.push("usage = ?"); values.push(extra.usage); }
    if (extra?.model !== undefined) { sets.push("model = ?"); values.push(extra.model); }
    if (status === "in_progress") { sets.push("started_at = ?"); values.push(now); }
    if (status === "completed" || status === "failed" || status === "cancelled") { sets.push("completed_at = ?"); values.push(now); }
    values.push(id);
    this.db.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`).run(...values);

    // E2ED auto-sync hook: when an issue reaches terminal state, notify
    // registered listeners so e2ed can advance requirement status.
    if (status === "completed" || status === "failed" || status === "cancelled") {
      this._onIssueTerminal?.(id);
    }
  }

  updateIssueWorkingDir(id: string, workingDir: string | null): void {
    this.db.prepare(
      "UPDATE issues SET working_dir = ?, updated_at = ? WHERE id = ?",
    ).run(workingDir, new Date().toISOString(), id);
  }

  /**
   * 反查最新绑定到某个 sessionId 的 issue。
   * session_id 由 migration 013 加入,无 session_id 列的旧 DB 走不到这里。
   */
  getLatestIssueBySessionId(sessionId: string): IssueRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issues WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(sessionId) as IssueRow | undefined;
  }

  /**
   * 查该 (cliTool, groupId) 下最新的 issue。Debug Sessions 视图用:
   * worker SessionStore 跟 issues.session_id 是两条独立路径(SessionStore
   * 只在 chat/collab 路径更新,issue 执行不写 SessionStore),所以反查
   * session_id 经常落空。改用 (cliTool, groupId) 取最新一条 issue,展示
   * 「上次 claude/codex 在这个群里跑了多少 token」更贴近用户预期。
   */
  getLatestIssueByCliTool(cliTool: string, groupId: string): IssueRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issues WHERE cli_tool = ? AND group_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(cliTool, groupId) as IssueRow | undefined;
  }

  /** Atomically claim the next unassigned issue for an executor agent. */
  claimNextIssue(agentName: string): IssueRow | undefined {
    const issue = this.db.prepare(`
      SELECT i.* FROM issues i
      JOIN groups g ON g.id = i.group_id
      WHERE i.status = 'open' AND i.assigned_to IS NULL AND i.type = 'task'
        AND g.archived_at IS NULL
      ORDER BY
        CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        i.created_at ASC
      LIMIT 1
    `).get() as IssueRow | undefined;
    if (!issue) return undefined;
    // Atomic update: only claim if still unassigned
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE issues SET assigned_to = ?, status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ? AND assigned_to IS NULL",
    ).run(agentName, now, now, issue.id);
    if (result.changes === 0) return undefined;
    this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, created_at)
      VALUES (?, 'assigned', ?, ?, ?)
    `).run(issue.id, agentName, `Claimed by ${agentName}`, now);
    return this.getIssueById(issue.id);
  }

  addIssueEvent(event: {
    issueId: string; eventType: string; agentName: string;
    content?: string; metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.issueId, event.eventType, event.agentName,
      event.content || "", JSON.stringify(event.metadata || {}),
      new Date().toISOString(),
    );
  }

  /**
   * Post a comment/message on an issue, optionally replying to a specific
   * event (message quoting). Returns the new event ID.
   */
  addIssueComment(issueId: string, agentName: string, content: string, replyToId?: number): number {
    const result = this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, metadata, reply_to_id, created_at)
      VALUES (?, 'comment', ?, ?, '{}', ?, ?)
    `).run(
      issueId, agentName, content, replyToId ?? null,
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Get all comment/collaboration messages for an issue, with reply-to
   * resolution (quoted message content + author embedded in the result).
   */
  getIssueMessages(issueId: string): Array<{
    id: number;
    event_type: string;
    agent_name: string;
    content: string;
    created_at: string;
    metadata: string;
    reply_to_id: number | null;
    /** Resolved quoted message, present when reply_to_id is set */
    quoted?: { id: number; agent_name: string; content: string; created_at: string } | null;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM issue_events
      WHERE issue_id = ? AND event_type IN ('comment', 'collaboration_turn')
      ORDER BY created_at ASC
    `).all(issueId) as IssueEventRow[];

    return rows.map((r) => {
      const msg: any = {
        id: r.id,
        event_type: r.event_type,
        agent_name: r.agent_name,
        content: r.content,
        created_at: r.created_at,
        metadata: r.metadata,
        reply_to_id: r.reply_to_id,
      };
      if (r.reply_to_id != null) {
        const quoted = this.db.prepare(
          "SELECT id, agent_name, content, created_at FROM issue_events WHERE id = ?",
        ).get(r.reply_to_id) as { id: number; agent_name: string; content: string; created_at: string } | undefined;
        msg.quoted = quoted ?? null;
      }
      return msg;
    });
  }

  // 拉取 issue 的事件流。
  //
  // 旧实现是 SELECT * ORDER BY created_at ASC LIMIT 200,在 issue 跑久了
  // events 累积超过 200 条时(典型如 worker 流式喷了大量 [status:thinking]
  // progress chunk)会把**最新**的事件截掉 —— 用户的追加指令(appended)
  // 即便已经入库、worker 已消费,也永远拉不回来,前端 reload 多少次都看不到。
  // 参见 issue 2284adfa 的复现。
  //
  // 现在:把事件拆成两类分别处理:
  //   - 非 progress(created/assigned/appended/approval_request/completed/failed/...)
  //     是用户关心的关键节点,**全部保留**,不受 limit 影响。
  //   - progress(worker 流式输出)条数最多,保留**最早 headKeep 条 + 最新
  //     tailKeep 条**,中间被省略的部分用 event_type='progress_truncated' 的
  //     虚拟事件标注,前端渲染成「已省略 N 条早期进展」chip。
  getIssueEvents(issueId: string, headKeep = 5, tailKeep = 145): IssueEventRow[] {
    const nonProgress = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type != 'progress' ORDER BY created_at ASC, id ASC",
    ).all(issueId) as IssueEventRow[];

    const progressCountRow = this.db.prepare(
      "SELECT COUNT(*) AS c FROM issue_events WHERE issue_id = ? AND event_type = 'progress'",
    ).get(issueId) as { c: number };

    const progressCount = progressCountRow.c;

    // progress 总数不超过 head+tail,直接全拿,不需要 marker。
    if (progressCount <= headKeep + tailKeep) {
      const allProgress = this.db.prepare(
        "SELECT * FROM issue_events WHERE issue_id = ? AND event_type = 'progress' ORDER BY created_at ASC, id ASC",
      ).all(issueId) as IssueEventRow[];
      return this.mergeIssueEvents([...nonProgress, ...allProgress]);
    }

    const head = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type = 'progress' ORDER BY id ASC LIMIT ?",
    ).all(issueId, headKeep) as IssueEventRow[];

    const tail = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type = 'progress' ORDER BY id DESC LIMIT ?",
    ).all(issueId, tailKeep).reverse() as IssueEventRow[];

    const omitted = progressCount - head.length - tail.length;

    // marker 插在 head 最后一条之后、tail 第一条之前。
    // created_at 取 head 末尾 +1ms,确保排序落在 head 和 tail 之间。
    const markerTime = head.length > 0
      ? new Date(Date.parse(head[head.length - 1].created_at) + 1).toISOString()
      : (tail[0]?.created_at ?? new Date().toISOString());

    const marker: IssueEventRow = {
      id: -1,
      issue_id: issueId,
      event_type: "progress_truncated",
      agent_name: "",
      content: "",
      metadata: JSON.stringify({ omitted }),
      created_at: markerTime,
      reply_to_id: null,
    };

    return this.mergeIssueEvents([...nonProgress, ...head, marker, ...tail]);
  }

  private mergeIssueEvents(rows: IssueEventRow[]): IssueEventRow[] {
    return rows.sort((a, b) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (ta !== tb) return ta - tb;
      return a.id - b.id;
    });
  }

  /** Get a single issue event by its ID. */
  getIssueEventById(eventId: number): IssueEventRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issue_events WHERE id = ?",
    ).get(eventId) as IssueEventRow | undefined;
  }

  /** Get all issue events for a group (across all issues in that group) */
  getIssueEventsByGroup(groupId: string, limit = 500): IssueEventRow[] {
    return this.db.prepare(
      "SELECT ie.* FROM issue_events ie JOIN issues i ON ie.issue_id = i.id WHERE i.group_id = ? ORDER BY ie.created_at ASC LIMIT ?",
    ).all(groupId, limit) as IssueEventRow[];
  }

  /**
   * Approvals piggy-back on issue_events (event_type='approval_request') —
   * their lifecycle ("pending" → "accepted"/"denied") lives inside the JSON
   * metadata column. Finding one requires a scan + JSON parse since approvalId
   * isn't indexed; the per-issue event count is small (capped at ~200) so this
   * is fine in practice.
   */
  findApprovalEvent(issueId: string, approvalId: string): IssueEventRow | undefined {
    const rows = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type = 'approval_request' ORDER BY created_at DESC",
    ).all(issueId) as IssueEventRow[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
        if (meta.approvalId === approvalId) return row;
      } catch { /* malformed metadata — skip */ }
    }
    return undefined;
  }

  /** Mark an approval event as resolved. Returns true if the row was updated.
   *  When `feedback` is provided and status is `denied`, it is persisted in
   *  metadata so the dashboard can render the rejection reason on the
   *  resolved card. */
  updateApprovalStatus(
    eventId: number,
    status: "accepted" | "denied",
    resolvedBy: string,
    feedback?: string,
  ): boolean {
    const row = this.db.prepare("SELECT metadata FROM issue_events WHERE id = ?").get(eventId) as
      | { metadata: string }
      | undefined;
    if (!row) return false;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata || "{}"); } catch { /* fall back to empty */ }
    meta.status = status;
    meta.resolvedBy = resolvedBy;
    meta.resolvedAt = new Date().toISOString();
    if (status === "denied" && feedback) meta.feedback = feedback;
    const result = this.db.prepare(
      "UPDATE issue_events SET metadata = ? WHERE id = ?",
    ).run(JSON.stringify(meta), eventId);
    return result.changes > 0;
  }

  deleteIssue(id: string): void {
    this.db.prepare("DELETE FROM issue_events WHERE issue_id = ?").run(id);
    this.db.prepare("DELETE FROM issues WHERE id = ?").run(id);
  }

  updateIssuePriority(id: string, priority: string): void {
    this.db.prepare(
      "UPDATE issues SET priority = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(priority, id);
  }

  // 同时支持 title / description 的部分更新。两个字段都不传时返回 false。
  // 标题在调用方已经做过非空校验，这里只负责落库。
  updateIssueContent(id: string, fields: { title?: string; description?: string; slashCommand?: string | null; approvalPolicy?: "r_allow" | "rw_allow" }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (fields.slashCommand !== undefined) { sets.push("slash_command = ?"); params.push(fields.slashCommand); }
    if (fields.approvalPolicy !== undefined) { sets.push("approval_policy = ?"); params.push(fields.approvalPolicy); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    const result = this.db.prepare(
      `UPDATE issues SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...(params as never[]));
    return result.changes > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Notes (极简文字记录,仅 CRUD,无执行流程)
  // ═══════════════════════════════════════════════════════════════════════════

  createNote(note: {
    id: string; groupId: string; title: string;
    description?: string; createdBy: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notes (id, group_id, title, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      note.id, note.groupId, note.title,
      note.description || "", note.createdBy,
      now, now,
    );
  }

  getNoteById(id: string): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  }

  listNotesByGroup(groupId: string): NoteRow[] {
    return this.db.prepare(
      "SELECT * FROM notes WHERE group_id = ? ORDER BY created_at DESC",
    ).all(groupId) as NoteRow[];
  }

  updateNote(id: string, fields: { title?: string; description?: string }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    const result = this.db.prepare(
      `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...(params as never[]));
    return result.changes > 0;
  }

  deleteNote(id: string): void {
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Collaboration issues (multi-agent collaboration tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  createCollaborationIssue(data: {
    id: string; groupId: string; title: string; collaborationGoal: string;
    participants: string[]; maxRounds: number; owner: string; createdBy: string;
  }): void {
    this.db.prepare(`
      INSERT INTO issues (id, group_id, title, type, status, collaboration_goal,
        max_rounds, current_round, participants, owner, created_by, approval_policy)
      VALUES (?, ?, ?, 'collaboration', 'in_progress', ?, ?, 1, ?, ?, ?, 'rw_allow')
    `).run(
      data.id, data.groupId, data.title, data.collaborationGoal,
      data.maxRounds, JSON.stringify(data.participants),
      data.owner, data.createdBy,
    );
    // Initialize round tracker for round 1
    for (const agent of data.participants) {
      this.db.prepare(`
        INSERT INTO collaboration_round_tracker (issue_id, round, agent_name, has_contributed)
        VALUES (?, 1, ?, 0)
      `).run(data.id, agent);
    }
    this.addIssueEvent({
      issueId: data.id, eventType: "collaboration_started",
      agentName: data.createdBy,
      content: `Collaboration started: ${data.title}`,
      metadata: { goal: data.collaborationGoal, participants: data.participants, maxRounds: data.maxRounds, owner: data.owner },
    });
  }

  getActiveCollaborationsByGroup(groupId: string): IssueRow[] {
    return this.db.prepare(
      "SELECT * FROM issues WHERE group_id = ? AND type = 'collaboration' AND status = 'in_progress'",
    ).all(groupId) as IssueRow[];
  }

  recordCollaborationTurn(issueId: string, agentName: string, round: number, content?: string): void {
    this.db.prepare(`
      INSERT INTO collaboration_round_tracker (issue_id, round, agent_name, has_contributed)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(issue_id, round, agent_name) DO UPDATE SET has_contributed = 1
    `).run(issueId, round, agentName);
    this.addIssueEvent({
      issueId, eventType: "collaboration_turn", agentName,
      content: content || `${agentName} contributed in round ${round}`,
      metadata: { round },
    });
  }

  /**
   * Collect collaboration context for the next-speaker prompt:
   *  - lastRoundTurns: full content of every turn in (currentRound - 1)
   *  - earlierSpeakers: agent names that spoke in rounds before lastRound
   */
  buildCollaborationContext(issueId: string, currentRound: number): {
    lastRoundTurns: { agentName: string; content: string }[];
    earlierSpeakers: string[];
  } {
    const events = this.db.prepare(
      "SELECT agent_name, content, metadata FROM issue_events WHERE issue_id = ? AND event_type = 'collaboration_turn' ORDER BY created_at ASC",
    ).all(issueId) as { agent_name: string; content: string; metadata: string }[];

    const lastRound = currentRound - 1;
    const lastRoundTurns: { agentName: string; content: string }[] = [];
    const earlier = new Set<string>();
    for (const ev of events) {
      let round = 0;
      try { round = (JSON.parse(ev.metadata || "{}").round as number) ?? 0; } catch { /* ignore */ }
      if (round === lastRound) {
        lastRoundTurns.push({ agentName: ev.agent_name, content: ev.content });
      } else if (round > 0 && round < lastRound) {
        earlier.add(ev.agent_name);
      }
    }
    return { lastRoundTurns, earlierSpeakers: Array.from(earlier) };
  }

  hasAgentContributedThisRound(issueId: string, agentName: string, round: number): boolean {
    const row = this.db.prepare(
      "SELECT has_contributed FROM collaboration_round_tracker WHERE issue_id = ? AND round = ? AND agent_name = ?",
    ).get(issueId, round, agentName) as { has_contributed: number } | undefined;
    return row?.has_contributed === 1;
  }

  getRoundTracker(issueId: string, round: number): { agent_name: string; has_contributed: number }[] {
    return this.db.prepare(
      "SELECT agent_name, has_contributed FROM collaboration_round_tracker WHERE issue_id = ? AND round = ?",
    ).all(issueId, round) as { agent_name: string; has_contributed: number }[];
  }

  isRoundComplete(issueId: string, round: number): boolean {
    const rows = this.getRoundTracker(issueId, round);
    return rows.length > 0 && rows.every((r) => r.has_contributed === 1);
  }

  advanceCollaborationRound(issueId: string, participants: string[]): void {
    const issue = this.getIssueById(issueId);
    if (!issue) return;
    const nextRound = (issue.current_round ?? 0) + 1;
    this.db.prepare(
      "UPDATE issues SET current_round = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(nextRound, issueId);
    // Initialize tracker for the new round
    for (const agent of participants) {
      this.db.prepare(`
        INSERT INTO collaboration_round_tracker (issue_id, round, agent_name, has_contributed)
        VALUES (?, ?, ?, 0)
      `).run(issueId, nextRound, agent);
    }
    this.addIssueEvent({
      issueId, eventType: "collaboration_round_start", agentName: "system",
      content: `Round ${nextRound} started`,
      metadata: { round: nextRound },
    });
  }

  completeCollaboration(issueId: string, summary: string): void {
    this.db.prepare(`
      UPDATE issues SET status = 'completed', summary = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(summary, issueId);
    this.addIssueEvent({
      issueId, eventType: "collaboration_concluded", agentName: "system",
      content: `Collaboration concluded`,
      metadata: { summary },
    });
  }

  close(): void {
    this.db.close();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scheduled tasks
  // ═══════════════════════════════════════════════════════════════════════════

  listScheduledTasks(filter?: { groupId?: string }): ScheduledTaskRow[] {
    let sql = "SELECT * FROM scheduled_tasks WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.groupId) {
      sql += " AND group_id = ?";
      params.push(filter.groupId);
    }
    sql += " ORDER BY id DESC";
    return this.db.prepare(sql).all(...params) as ScheduledTaskRow[];
  }

  getScheduledTask(id: number): ScheduledTaskRow | undefined {
    return this.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id) as ScheduledTaskRow | undefined;
  }

  /** 返回所有已启用、且 next_run_at <= now 的任务。调度器串行消费。 */
  getDueScheduledTasks(now: number): ScheduledTaskRow[] {
    return this.db.prepare(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
    ).all(now) as ScheduledTaskRow[];
  }

  /** 新建任务;返回插入后的完整 row(包含自动算出的首个 next_run_at)。 */
  createScheduledTask(input: {
    name: string;
    groupId: string;
    mode: "agent" | "message";
    agentName?: string | null;
    scheduleKind: "once" | "interval";
    intervalSec?: number | null;
    runAt?: number | null;
    prompt: string;
    repeatTimes?: number | null;
    enabled?: boolean;
  }): ScheduledTaskRow {
    const now = Date.now();
    const enabled = input.enabled === false ? 0 : 1;
    const nextRunAt = input.scheduleKind === "once"
      ? (input.runAt ?? now)
      : now + (input.intervalSec ?? 0) * 1000;
    const info = this.db.prepare(`
      INSERT INTO scheduled_tasks (
        name, group_id, mode, agent_name, schedule_kind, interval_sec, run_at,
        prompt, enabled, next_run_at, repeat_times, repeat_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.name,
      input.groupId,
      input.mode,
      input.agentName ?? null,
      input.scheduleKind,
      input.intervalSec ?? null,
      input.runAt ?? null,
      input.prompt,
      enabled,
      nextRunAt,
      input.repeatTimes ?? null,
      now,
      now,
    );
    return this.getScheduledTask(Number(info.lastInsertRowid))!;
  }

  /** 部分更新;改 schedule 字段会触发 next_run_at 重算。 */
  updateScheduledTask(id: number, patch: {
    name?: string;
    mode?: "agent" | "message";
    agentName?: string | null;
    scheduleKind?: "once" | "interval";
    intervalSec?: number | null;
    runAt?: number | null;
    prompt?: string;
    enabled?: boolean;
    repeatTimes?: number | null;
  }): ScheduledTaskRow | undefined {
    const task = this.getScheduledTask(id);
    if (!task) return undefined;

    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); values.push(patch.name); }
    if (patch.mode !== undefined) { sets.push("mode = ?"); values.push(patch.mode); }
    if (patch.agentName !== undefined) { sets.push("agent_name = ?"); values.push(patch.agentName); }
    if (patch.prompt !== undefined) { sets.push("prompt = ?"); values.push(patch.prompt); }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); values.push(patch.enabled ? 1 : 0); }
    if (patch.repeatTimes !== undefined) { sets.push("repeat_times = ?"); values.push(patch.repeatTimes); }

    // schedule_kind / interval_sec / run_at 任一变化都重算 next_run_at
    const scheduleChanged =
      patch.scheduleKind !== undefined ||
      patch.intervalSec !== undefined ||
      patch.runAt !== undefined;
    if (scheduleChanged) {
      const kind = patch.scheduleKind ?? task.schedule_kind;
      const intervalSec = patch.intervalSec !== undefined ? patch.intervalSec : task.interval_sec;
      const runAt = patch.runAt !== undefined ? patch.runAt : task.run_at;
      const now = Date.now();
      const nextRunAt = kind === "once"
        ? (runAt ?? now)
        : now + (intervalSec ?? 0) * 1000;
      sets.push("schedule_kind = ?"); values.push(kind);
      sets.push("interval_sec = ?"); values.push(intervalSec);
      sets.push("run_at = ?"); values.push(runAt);
      sets.push("next_run_at = ?"); values.push(nextRunAt);
    }

    if (sets.length === 0) return task;

    sets.push("updated_at = ?"); values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getScheduledTask(id);
  }

  deleteScheduledTask(id: number): boolean {
    const result = this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /** at-most-once 推进:先把 next_run_at 推到下一个未来时间点,再执行。 */
  rescheduleTask(id: number, nextRunAt: number): void {
    this.db.prepare(
      "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?",
    ).run(nextRunAt, Date.now(), id);
  }

  /** 立刻触发:把 next_run_at 设为 now,下一个 tick 就跑。 */
  triggerScheduledTask(id: number, now: number = Date.now()): boolean {
    const result = this.db.prepare(
      "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1",
    ).run(now, Date.now(), id);
    return result.changes > 0;
  }

  /** 记录本次执行结果。repeat_count 由调度器计算后传入,这里直接覆写。
   *  issueId=null 保留上一次 last_issue_id（用于 agent skip 的防堆积场景 —— 下一轮继续反查同一个 prev issue）;
   *  传字符串才覆写。
   *  没有显式 clear 路径 —— last_issue_id 一旦被 agent 模式写入就持续追踪到 disable 为止。 */
  markScheduledTaskRun(
    id: number,
    runAt: number,
    status: "ok" | "error" | "skipped",
    error: string | null,
    issueId: string | null,
    repeatCount: number,
  ): void {
    if (issueId !== null) {
      this.db.prepare(`
        UPDATE scheduled_tasks SET
          last_run_at = ?,
          last_status = ?,
          last_error = ?,
          last_issue_id = ?,
          repeat_count = ?,
          updated_at = ?
        WHERE id = ?
      `).run(runAt, status, error, issueId, repeatCount, Date.now(), id);
    } else {
      this.db.prepare(`
        UPDATE scheduled_tasks SET
          last_run_at = ?,
          last_status = ?,
          last_error = ?,
          repeat_count = ?,
          updated_at = ?
        WHERE id = ?
      `).run(runAt, status, error, repeatCount, Date.now(), id);
    }
  }

  /** 一次性任务跑完,或 repeat_times 用尽,自动 enabled=0。 */
  disableScheduledTask(id: number): void {
    this.db.prepare(
      "UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?",
    ).run(Date.now(), id);
  }
}
