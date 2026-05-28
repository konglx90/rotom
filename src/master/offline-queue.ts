/**
 * Digital Employee Mesh — Offline message queue
 *
 * Thin wrapper over db methods + JSON → OfflineMsg conversion.
 */

import type { MeshDb } from "./db.js";
import type { OfflineMsg, MessagePayload } from "../shared/protocol.js";

export class OfflineQueue {
  constructor(private db: MeshDb) {}

  /** Enqueue a message for an offline agent. Returns false if limit reached. */
  enqueue(
    targetAgentId: string,
    fromName: string,
    fromDomain: string | undefined,
    payload: MessagePayload,
    routeType: string,
  ): boolean {
    return this.db.enqueueOffline(
      targetAgentId,
      fromName,
      fromDomain,
      JSON.stringify(payload),
      routeType,
    );
  }

  /** Pop all pending messages for an agent (called on reconnect). */
  pop(targetAgentId: string): OfflineMsg[] {
    const rows = this.db.popOffline(targetAgentId);
    return rows.map((row: any) => {
      let payload: MessagePayload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = { message: row.payload || "" };
      }
      return {
        from: {
          name: row.from_name,
          domain: row.from_domain || undefined,
          status: "offline" as const,
        },
        payload,
        routeType: row.route_type || "unknown",
        createdAt: row.created_at,
      };
    });
  }
}
