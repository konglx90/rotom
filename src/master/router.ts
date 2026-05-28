/**
 * Digital Employee Mesh — Router
 *
 * One routing mode: exact.
 * Router only makes decisions — it does NOT send messages.
 * WSHub reads the result and handles actual delivery.
 */

import type { MeshDb } from "./db.js";
import { MessageDedup } from "../shared/dedup.js";
import {
  DEDUP_TTL_MS,
  CLEANUP_INTERVAL_MS,
  PENDING_REQUEST_TTL_MS,
} from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Route result
// ---------------------------------------------------------------------------

export interface RouteResult {
  /** Target agent ID to deliver to (undefined = no target found) */
  targetAgentId?: string;
  targetName?: string;
  delivered: boolean;
  queued: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class Router {
  private dedup = new MessageDedup(DEDUP_TTL_MS);
  private pendingRequests = new Map<string, { fromAgentId: string; createdAt: number; conversation?: import("../shared/protocol.js").ConversationContext }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private db: MeshDb,
    private logger: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void },
  ) {
    // Periodic cleanup of dedup and pending requests
    this.cleanupTimer = setInterval(() => {
      this.dedup.cleanup();
      const now = Date.now();
      for (const [id, entry] of this.pendingRequests) {
        if (now - entry.createdAt > PENDING_REQUEST_TTL_MS) {
          this.pendingRequests.delete(id);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Route a message. Returns a decision (targetAgentId) — caller handles delivery.
   */
  route(fromAgentId: string, msg: {
    requestId: string;
    target?: string;
    payload: { message: string };
  }): RouteResult {
    // Dedup
    if (this.dedup.isDuplicate(msg.requestId)) {
      return { delivered: false, queued: false, error: "Duplicate message" };
    }
    this.dedup.mark(msg.requestId);

    // Resolve sender info
    const fromAgent = this.db.getAgentById(fromAgentId) as any;
    const fromName: string = fromAgent?.name || "unknown";
    const fromDomain: string | undefined = fromAgent?.domain;
    const summary = (msg.payload?.message || "").slice(0, 100);

    // Record for reply correlation (preserve conversation for reply path)
    this.pendingRequests.set(msg.requestId, { fromAgentId, createdAt: Date.now(), conversation: (msg as any).conversation });

    // Route
    if (msg.target) {
      return this.routeExact(fromAgentId, fromName, fromDomain, msg.target, summary);
    }
    return { delivered: false, queued: false, error: "No target specified" };
  }

  /**
   * Resolve the original sender for a reply. Returns agentId or undefined.
   * Does NOT consume the entry — allows multi-round replies on the same requestId.
   * Entry is cleaned up by TTL instead.
   */
  resolveReplyTarget(requestId: string): string | undefined {
    const entry = this.pendingRequests.get(requestId);
    if (entry) {
      entry.createdAt = Date.now();
      return entry.fromAgentId;
    }
    return undefined;
  }

  /**
   * Get the conversation context associated with a pending request.
   */
  getConversation(requestId: string): import("../shared/protocol.js").ConversationContext | undefined {
    return this.pendingRequests.get(requestId)?.conversation;
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private routing methods
  // ═══════════════════════════════════════════════════════════════════════════

  private routeExact(
    _fromId: string, fromName: string, fromDomain: string | undefined,
    targetName: string, summary: string,
  ): RouteResult {
    const target = this.db.getAgentByName(targetName) as any;
    if (!target) {
      this.db.audit({ fromName, fromDomain, toName: targetName, routeType: "exact", result: "failed", messageSummary: summary });
      return { delivered: false, queued: false, error: `Agent "${targetName}" not found` };
    }

    // Check if target agent is disabled
    if (target.enabled === 0) {
      this.db.audit({ fromName, fromDomain, toName: target.name, toDomain: target.domain, routeType: "exact", result: "rejected", messageSummary: summary });
      return { delivered: false, queued: false, error: `Agent "${targetName}" is disabled` };
    }

    if (!this.db.canCrossDomain(fromDomain, target.domain)) {
      this.db.audit({ fromName, fromDomain, toName: target.name, toDomain: target.domain, routeType: "exact", result: "rejected", messageSummary: summary });
      return { delivered: false, queued: false, error: "Cross-domain not allowed" };
    }

    this.db.audit({ fromName, fromDomain, toName: target.name, toDomain: target.domain, routeType: "exact", result: "routed", messageSummary: summary });
    return { targetAgentId: target.id, targetName: target.name, delivered: false, queued: false };
  }

}
