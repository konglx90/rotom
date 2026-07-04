/**
 * Directory — agent roster broadcast + per-agent config push.
 *
 * The directory is a denormalized view of the agents table that every
 * connected agent holds in memory. Whenever an agent joins, leaves, or
 * updates its description/profile, master fans out a `directory_update`
 * to all connected agents so their local copies stay fresh.
 *
 * Methods attach via Object.assign. `parseProfile` is shared with hub.ts.
 */

import type { AgentInfo } from "../../shared/protocol.js";
import { parseProfile, type WSHubSelf } from "./hub.js";

export const directoryMethods = {
  getDirectory(this: WSHubSelf): AgentInfo[] {
    return this.db.listAgents().map((a) => ({
      name: a.name,
      domain: a.domain || undefined,
      description: a.description || undefined,
      status: a.status as "online" | "offline",
      enabled: a.enabled !== 0,
      profile: parseProfile(a.profile),
    }));
  },

  /** Push a config_update to a specific connected Agent (called by API layer). */
  pushConfigUpdate(this: WSHubSelf, agentId: string, config: { domain?: string; enabled?: boolean }): boolean {
    const conn = this.connections.get(agentId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    // Update in-memory connection state
    if (config.domain !== undefined) conn.domain = config.domain;

    this.send(conn.ws, { type: "config_update", ...config });
    this.logger.info(`[mesh] Pushed config_update to ${conn.name}: ${JSON.stringify(config)}`);
    return true;
  },

  /** Read agent from DB and broadcast directory_update to all connected agents. */
  broadcastAgentUpdate(this: WSHubSelf, agentId: string): void {
    const agent = this.db.getAgentById(agentId);
    if (!agent) return;
    this.broadcastDirectory("update", {
      name: agent.name,
      domain: agent.domain || undefined,
      description: agent.description || undefined,
      status: agent.status as "online" | "offline",
      enabled: agent.enabled !== 0,
      profile: parseProfile(agent.profile),
    });
  },

  broadcastDirectory(this: WSHubSelf, event: "join" | "leave" | "update", agent: AgentInfo): void {
    const msg = { type: "directory_update" as const, event, agent };
    for (const conn of this.connections.values()) {
      this.send(conn.ws, msg);
    }
  },

  /**
   * 返回所有 online agent 的 cliTool 映射(name → cliTool)。
   * 给 API /agents 列表用 —— DB 不存 cliTool(那是 worker 的运行时属性),
   * 但 dashboard 想展示"这个 agent 用什么 CLI 跑"。
   * Offline agent 不在 map 里(没有连接)。
   */
  onlineCliTools(this: WSHubSelf): Map<string, string> {
    const out = new Map<string, string>();
    for (const conn of this.connections.values()) {
      if (conn.cliTool) {
        out.set(conn.name, conn.cliTool);
      }
    }
    return out;
  },
};