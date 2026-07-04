import { nowBeijing } from "../../shared/time.js";
import { buildUpdate } from "./build-update.js";
/**
 * Agents — CRUD + presence lifecycle (online/offline/heartbeat).
 *
 * Methods attach to a `MeshDb` instance via `Object.assign(this, agentMethods)`
 * in the MeshDb constructor. `this` is typed as `MeshDbSelf` so cross-module
 * calls (e.g. messages.enqueueOffline → getAgentById) compile.
 */

import type { AgentRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

export const agentMethods = {
  getAgentByName(this: MeshDbSelf, name: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  },

  /**
   * 跨 hostname 维度查询(本机内仍按 hostname 复合键,但本机内 name 已 UNIQUE,
   * 等价于 getAgentByName;留给 Phase 2 federation 使用)。
   */
  getAgentByHostAndName(this: MeshDbSelf, hostname: string, name: string): AgentRow | undefined {
    return this.db.prepare(
      "SELECT * FROM agents WHERE hostname = ? AND name = ?",
    ).get(hostname, name) as AgentRow | undefined;
  },

  /**
   * 本机 agent 查询:隐式注入本机 hostname(从 master_node 读)。
   * Phase 1 的高频路径 —— 本机 executor / dashboard 调用都走这里。
   * 如果 master_node 还没身份行(早期启动阶段),fallback 按 name 查(向后兼容)。
   */
  getLocalAgentByName(this: MeshDbSelf, name: string): AgentRow | undefined {
    const localHostname = this.getLocalHostname();
    if (localHostname) {
      return this.db.prepare(
        "SELECT * FROM agents WHERE hostname = ? AND name = ?",
      ).get(localHostname, name) as AgentRow | undefined;
    }
    return this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRow | undefined;
  },

  getAgentById(this: MeshDbSelf, id: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  },

  /** Lookup agent by token hash — used as fallback when name changes but token stays the same. */
  getAgentByTokenHash(this: MeshDbSelf, tokenHash: string): AgentRow | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(tokenHash) as AgentRow | undefined;
  },

  /** Update agent name (used when agent reconnects with a new name but same token). */
  updateAgentName(this: MeshDbSelf, id: string, name: string): void {
    this.db.prepare(
      "UPDATE agents SET name = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(name, id);
  },

  listAgents(
    this: MeshDbSelf,
    filter?: { status?: string; domain?: string; enabled?: boolean },
  ): AgentRow[] {
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
  },

  insertAgent(this: MeshDbSelf, agent: {
    id: string;
    name: string;
    description?: string;
    domain?: string;
    hostname?: string;
    tokenHash: string;
    token: string;
    profile?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO agents (id, name, description, domain, hostname, token_hash, token, profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.name,
      agent.description || null,
      agent.domain || null,
      agent.hostname ?? null,
      agent.tokenHash,
      agent.token,
      agent.profile || null,
    );
  },

  updateAgentMeta(
    this: MeshDbSelf,
    id: string,
    meta: { description?: string; domain?: string; profile?: string; avatar_url?: string },
  ): void {
    const built = buildUpdate({
      table: "agents",
      sets: {
        description: meta.description,
        domain: meta.domain,
        profile: meta.profile,
        avatar_url: meta.avatar_url,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "datetime-now",
    });
    if (built) this.db.prepare(built.sql).run(...built.params);
  },

  updateAgentEnabled(this: MeshDbSelf, id: string, enabled: boolean): void {
    this.db.prepare(
      "UPDATE agents SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(enabled ? 1 : 0, id);
  },

  setAgentOnline(
    this: MeshDbSelf,
    id: string,
    instance?: { instanceId?: string; hostname?: string; platform?: string; endpoint?: string; version?: string },
  ): void {
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
  },

  setAgentOffline(this: MeshDbSelf, id: string): void {
    this.db.prepare(
      "UPDATE agents SET status = 'offline', updated_at = datetime('now') WHERE id = ?",
    ).run(id);
  },

  /** Reset all agents to offline — called on Master startup to clear stale state. */
  resetAllOnline(this: MeshDbSelf): number {
    const result = this.db.prepare(
      "UPDATE agents SET status = 'offline', updated_at = datetime('now') WHERE status = 'online'",
    ).run();
    return result.changes;
  },

  updateAgentToken(this: MeshDbSelf, id: string, tokenHash: string, token: string): void {
    this.db.prepare(
      "UPDATE agents SET token_hash = ?, token = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(tokenHash, token, id);
    // Record token refresh timestamp for JWT iat validation.
    this.setConfig(`token_refreshed_at:${id}`, nowBeijing());
  },

  /** Get the timestamp when an agent's token was last refreshed. */
  getTokenRefreshedAt(this: MeshDbSelf, id: string): string | undefined {
    return this.getConfig(`token_refreshed_at:${id}`);
  },

  updateHeartbeat(this: MeshDbSelf, id: string): void {
    this.db.prepare(
      "UPDATE agents SET last_heartbeat = datetime('now') WHERE id = ?",
    ).run(id);
  },

  deleteAgent(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM offline_messages WHERE target_agent = ?").run(id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  },
};
