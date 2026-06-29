/**
 * Session management — Master ↔ Executor session routing.
 *
 * Dashboard 的 `/sessions` 端点现在直接读 master DB 的 `agent_sessions` 表
 * (替代了之前的 in-memory `sessionSnapshots` 缓存)。worker 仍然推
 * `session_snapshot`,master 在 connection.ts 里 upsert 到 DB + 更新内存
 * 缓存(缓存保留给 online 判定 + routeToExecutor 用)。
 *
 * `routeToExecutor` 是反向:master 把 view/delete 请求转发给匹配的 worker,
 * 取第一个响应。
 *
 * Methods attach via Object.assign.
 */

import type { ServerMessage, SessionEntry } from "../../shared/protocol.js";
import type { ConnectedAgent, WSHubSelf } from "./hub.js";

export const sessionsMethods = {
  /**
   * 列出该群所有 session(包括已失效的),按最近使用倒序。数据源是 DB。
   * online 字段由 connections 内存表 join 算出:该 session 的 (agentName,
   * cliTool) 对应的 worker 当前是否 WS 连着。
   *
   * `GET /sessions?groupId=X` 的快路径。
   */
  listSessionsByGroup(this: WSHubSelf, groupId: string): SessionEntry[] {
    const rows = this.db.listAgentSessionsByGroup(groupId);
    // 算 online:agent_name + cli_tool 同时匹配某个 connected worker
    const onlineKeys = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      if (!conn.cliTool) continue;
      onlineKeys.add(`${conn.name}:${conn.cliTool}`);
    }
    return rows.map(r => {
      const online = onlineKeys.has(`${r.agent_name}:${r.cli_tool}`);
      const entry: SessionEntry & { online?: boolean; invalidatedAt?: string | null } = {
        cliTool: r.cli_tool,
        groupId: r.group_id,
        sessionId: r.session_id,
        agentName: r.agent_name,
        usage: (r.input_tokens == null && r.output_tokens == null && r.total_cost_usd == null)
          ? null
          : {
              inputTokens: r.input_tokens ?? undefined,
              outputTokens: r.output_tokens ?? undefined,
              cacheReadTokens: r.cache_read_tokens ?? undefined,
              cacheCreationTokens: r.cache_creation_tokens ?? undefined,
              totalCostUsd: r.total_cost_usd ?? undefined,
            },
        model: r.model ?? null,
        cumulativeCostUsd: r.cumulative_cost_usd,
        cumulativeInputTokens: r.cumulative_input_tokens,
        cumulativeOutputTokens: r.cumulative_output_tokens,
        cumulativeCacheReadTokens: r.cumulative_cache_read_tokens,
        cumulativeCacheCreationTokens: r.cumulative_cache_creation_tokens,
        online,
        invalidatedAt: r.invalidated_at,
      };
      return entry;
    });
  },

  /**
   * 反查单条 session 的 usage/model/cumulative/online/invalidatedAt。
   * `GET /sessions/:.../usage` 用。直接读 DB,不再依赖 worker 在线。
   */
  findSessionEntry(this: WSHubSelf, sessionId: string): SessionEntry | undefined {
    const r = this.db.findAgentSession(sessionId);
    if (!r) return undefined;
    let online = false;
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      if (conn.name === r.agent_name && conn.cliTool === r.cli_tool) {
        online = true;
        break;
      }
    }
    return {
      cliTool: r.cli_tool,
      groupId: r.group_id,
      sessionId: r.session_id,
      agentName: r.agent_name,
      usage: (r.input_tokens == null && r.output_tokens == null && r.total_cost_usd == null)
        ? null
        : {
            inputTokens: r.input_tokens ?? undefined,
            outputTokens: r.output_tokens ?? undefined,
            cacheReadTokens: r.cache_read_tokens ?? undefined,
            cacheCreationTokens: r.cache_creation_tokens ?? undefined,
            totalCostUsd: r.total_cost_usd ?? undefined,
          },
      model: r.model ?? null,
      cumulativeCostUsd: r.cumulative_cost_usd,
      cumulativeInputTokens: r.cumulative_input_tokens,
      cumulativeOutputTokens: r.cumulative_output_tokens,
      cumulativeCacheReadTokens: r.cumulative_cache_read_tokens,
      cumulativeCacheCreationTokens: r.cumulative_cache_creation_tokens,
      online,
      invalidatedAt: r.invalidated_at,
    };
  },

  /**
   * Send a request to one or more online workers matching `predicate` and
   * return the **first** response received within `timeoutMs`. Other responses
   * (including late ones) are dropped.
   *
   * Used by /sessions endpoints:
   *   - view:   predicate = cliTool match,        timeoutMs = 5s
   *   - delete: predicate = cliTool match,        timeoutMs = 5s
   *
   * Rejects with a TimeoutError if no worker answers in time. The HTTP layer
   * maps that to a 504.
   */
  routeToExecutor(
    this: WSHubSelf,
    predicate: (conn: ConnectedAgent) => boolean,
    payload: ServerMessage & { requestId: string },
    timeoutMs = 5_000,
  ): Promise<import("../../shared/protocol.js").ClientSessionViewResponse | import("../../shared/protocol.js").ClientSessionDeleteResponse> {
    const targets = [...this.connections.values()].filter(
      (c) => c.ws.readyState === WebSocket.OPEN && predicate(c),
    );
    if (targets.length === 0) {
      return Promise.reject(new Error("no matching executor online"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSessionRequests.delete(payload.requestId);
        reject(new Error(`executor did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingSessionRequests.set(payload.requestId, { resolve, reject, timer });
      for (const conn of targets) {
        this.send(conn.ws, payload);
      }
    });
  },
};
