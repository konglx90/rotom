/**
 * Messages — offline queue, audit log, message log (dashboard conversations),
 * retention cleanup, and aggregate stats.
 *
 * Methods attach to a `MeshDb` instance via `Object.assign`. Cross-module
 * calls: `enqueueOffline` → `getAgentById` (agents); `stats` → `listAgents`.
 */

import { LOG_RETENTION_DAYS } from "../../shared/constants.js";
import type { AuditLogRow, MessageLogRow, OfflineMessageRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

export const messageMethods = {
  // ─────────────────────────────────────────────────────────────────────────
  // Offline messages
  // ─────────────────────────────────────────────────────────────────────────

  enqueueOffline(
    this: MeshDbSelf,
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
  },

  popOffline(this: MeshDbSelf, targetAgent: string): OfflineMessageRow[] {
    const msgs = this.db.prepare(
      "SELECT * FROM offline_messages WHERE target_agent = ? AND expires_at > datetime('now') ORDER BY created_at",
    ).all(targetAgent) as OfflineMessageRow[];

    if (msgs.length > 0) {
      this.db.prepare("DELETE FROM offline_messages WHERE target_agent = ?").run(targetAgent);
    }
    return msgs;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Federation offline messages (跨 master 暂存重投)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 暂存一条跨 master FedDeliver(target member 离线时由协调 master 调用)。
   *
   * 复用 offline_messages 表(migration 057/059 扩的 3 列),按 target_master_id 主键查重投。
   * 不做"target agent 是否存在"的校验——member 重连后如果该 agent 还在 agent_visibility
   * 就投,不在就由 member 端 FedClient.handleDeliver 返回 false,coord 记 route_failed。
   *
   * per-member 100 条上限(对齐本地 agent 离线队列)。
   */
  enqueueFedOffline(
    this: MeshDbSelf,
    input: {
      target_master_id: string;
      target_hostname: string;
      target_agent: string;
      source_master_id: string;
      source_hostname: string;
      source_agent: string;
      payload: string; // JSON.stringify(FedRouteDeliver)
      request_id: string;
    },
  ): boolean {
    // Purge expired(同 enqueueOffline 的清理时机)
    this.db.prepare("DELETE FROM offline_messages WHERE expires_at < datetime('now')").run();

    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM offline_messages WHERE target_master_id = ?",
    ).get(input.target_master_id) as { c: number };
    if (row.c >= 100) return false;

    this.db.prepare(`
      INSERT INTO offline_messages
        (target_agent, from_name, from_domain, payload, route_type, expires_at,
         target_hostname, source_master_id, target_master_id)
      VALUES (?, ?, ?, ?, 'federated', datetime('now', '+1 day'), ?, ?, ?)
    `).run(
      input.target_agent,
      input.source_agent,
      input.source_hostname,
      input.payload,
      input.target_hostname,
      input.source_master_id,
      input.target_master_id,
    );
    return true;
  },

  /** 取出并删除某 member 的所有 fed 暂存消息(原子,member 重连时调用) */
  popFedOfflineByMaster(this: MeshDbSelf, targetMasterId: string): OfflineMessageRow[] {
    const msgs = this.db.prepare(
      `SELECT * FROM offline_messages
       WHERE target_master_id = ? AND expires_at > datetime('now')
       ORDER BY created_at`,
    ).all(targetMasterId) as OfflineMessageRow[];

    if (msgs.length > 0) {
      this.db.prepare("DELETE FROM offline_messages WHERE target_master_id = ?").run(targetMasterId);
    }
    return msgs;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Audit
  // ─────────────────────────────────────────────────────────────────────────

  audit(this: MeshDbSelf, entry: {
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
  },

  listAudit(this: MeshDbSelf, limit: number = 50): AuditLogRow[] {
    return this.db.prepare(
      "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?",
    ).all(limit) as AuditLogRow[];
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Config (general key/value)
  // ─────────────────────────────────────────────────────────────────────────

  getConfig(this: MeshDbSelf, key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  },

  setConfig(this: MeshDbSelf, key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Message log (for dashboard conversations)
  // ─────────────────────────────────────────────────────────────────────────

  logMessage(this: MeshDbSelf, entry: {
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
  },

  listMessages(this: MeshDbSelf, opts?: {
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
  },

  countMessages(this: MeshDbSelf, opts?: {
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
  },

  /** Per-agent message stats */
  agentMessageStats(this: MeshDbSelf): Record<string, unknown>[] {
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
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Log cleanup — prevents unbounded table growth
  // ─────────────────────────────────────────────────────────────────────────

  /** Delete audit_log and message_log entries older than retention period. */
  cleanupOldLogs(
    this: MeshDbSelf,
    retentionDays: number = LOG_RETENTION_DAYS,
  ): { auditDeleted: number; messageDeleted: number } {
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
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Aggregate stats
  // ─────────────────────────────────────────────────────────────────────────

  stats(this: MeshDbSelf): { total: number; online: number; domains: number } {
    const agents = this.listAgents() as Array<{ status: string }>;
    return {
      total: agents.length,
      online: agents.filter(a => a.status === "online").length,
      domains: (this.db.prepare(
        "SELECT COUNT(DISTINCT domain) as c FROM agents WHERE domain IS NOT NULL AND domain != ''",
      ).get() as { c: number }).c,
    };
  },
};