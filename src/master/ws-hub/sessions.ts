/**
 * Session management — Master ↔ Executor session routing.
 *
 * The dashboard's `/sessions` endpoints need per-worker SessionStore data.
 * Workers push a `session_snapshot` after auth and after every mutation;
 * master holds it in memory (`sessionSnapshots`) so HTTP GETs can answer
 * without round-tripping each worker.
 *
 * `routeToExecutor` is the inverse direction — master forwards a request
 * to one or more workers matching a predicate, returns the first response
 * within timeout. Used by /sessions view + delete endpoints.
 *
 * Methods attach via Object.assign.
 */

import type { ServerMessage, SessionEntry } from "../../shared/protocol.js";
import type { ConnectedAgent, WSHubSelf } from "./hub.js";

export const sessionsMethods = {
  /**
   * Aggregate every connected worker's cached SessionStore snapshot and return
   * only entries belonging to `groupId`. Deduplicates by `(cliTool, sessionId)`
   * — in single-worker-per-cliTool deployments this is a no-op, but if two
   * workers with the same cliTool both claim an entry we keep the first one.
   *
   * This is the fast path for `GET /sessions?groupId=X`: no WS broadcast, no
   * waiting on worker responses. The cache is kept fresh by workers pushing
   * `session_snapshot` after auth and after every mutation.
   */
  listSessionsByGroup(this: WSHubSelf, groupId: string): SessionEntry[] {
    const seen = new Set<string>();
    const out: SessionEntry[] = [];
    for (const [agentId, entries] of this.sessionSnapshots) {
      const agentName = this.connections.get(agentId)?.name;
      for (const entry of entries) {
        if (entry.groupId !== groupId) continue;
        const key = `${agentId}:${entry.cliTool}:${entry.sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(agentName ? { ...entry, agentName } : entry);
      }
    }
    return out;
  },

  /**
   * Look up a single session's cached usage/model by sessionId. Used by
   * `GET /sessions/:cliTool/:groupId/:sessionId/usage` — reads straight from
   * the in-memory snapshot cache (workers push usage/model after every chat
   * turn), no DB lookup. Returns undefined when no connected worker has
   * reported this sessionId yet.
   */
  findSessionEntry(this: WSHubSelf, sessionId: string): SessionEntry | undefined {
    for (const entries of this.sessionSnapshots.values()) {
      const hit = entries.find((e) => e.sessionId === sessionId);
      if (hit) return hit;
    }
    return undefined;
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