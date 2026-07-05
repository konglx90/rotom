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
import type { FedClient } from "./federation/client.js";
import type { FedRouteDeliver, FedRouteReply } from "../shared/protocol/federation.js";
import { parseAgentRef } from "../shared/protocol/federation.js";

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

/** Sentinel fromAgentId for federated pending requests(本地 ws-hub 永远不会拿这个 id 去路由) */
export const FEDERATED_REPLY_MARKER = "__federation__";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface FederatedReplyHook {
  /** 本地 agent 给一个 federated 请求回了消息 → 通过 federation 把 FedReply 发回来源 */
  (requestId: string, fromName: string, payload: { message: string }): void;
}

export class Router {
  private dedup = new MessageDedup(DEDUP_TTL_MS);
  private pendingRequests = new Map<string, {
    fromAgentId: string;
    createdAt: number;
    conversation?: import("../shared/protocol.js").ConversationContext;
    /** 标记此请求来自 federation(对端 member 经 FedDeliver 投来的);本地 agent 回复时走 fedReplyHook 而非 sendToAgent */
    isFederated?: boolean;
  }>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  /** Federation 客户端(member 模式);standalone 时为 undefined */
  private fedClient?: FedClient;
  /** 已加入的 teamId(用于查 agent_visibility 缓存) */
  private teamId?: string;
  /** 本机 hostname(用于 from.hostname 字段) */
  private localHostname?: string;
  /** Federation 回复 hook:本地 agent 回复 federated 请求时调用,由 FederationManager 注入 */
  fedReplyHook?: FederatedReplyHook;

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

  /**
   * 注入 federation 客户端(member 模式时由 server.ts 调用)。
   * 注入后 Router 才会走 federated 路由分支。
   */
  setFederation(client: FedClient, teamId: string, localHostname: string): void {
    this.fedClient = client;
    this.teamId = teamId;
    this.localHostname = localHostname;
  }

  /**
   * Federation deliver 入口:协调 master / member 收到 FedDeliver 后调这个,
   * 让本机 WSHub 投递到目标本地 agent。
   * 返回 true=已找到目标并投递(由调用方实际 send)。
   */
  handleFedDeliver(msg: FedRouteDeliver, sendToLocal: (agentName: string, payload: { message: string }) => boolean): boolean {
    // to.name 在本机查
    const target = this.db.getLocalAgentByName(msg.to.name)
      ?? this.db.getAgentByName(msg.to.name);
    if (!target) return false;
    return sendToLocal(target.name as string, msg.payload);
  }

  /** Federation reply 入口:FedReply 到达后,resolve pendingRequest 路由回来源 */
  handleFedReply(msg: FedRouteReply, sendReply: (fromAgentId: string, payload: { message: string }) => void): void {
    const entry = this.pendingRequests.get(msg.requestId);
    if (entry) {
      sendReply(entry.fromAgentId, msg.payload);
    }
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
      return this.routeExact(
        fromAgentId, fromName, fromDomain, msg.target, summary,
        msg.requestId,
        msg.payload as { message: string; files?: Array<{ name: string; uri: string }> } | undefined,
      );
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

  /** 查询 requestId 是否来自 federation(本地 agent 回复时若为 true,走 fedReplyHook 而非 sendToAgent) */
  isFederatedRequest(requestId: string): boolean {
    return this.pendingRequests.get(requestId)?.isFederated === true;
  }

  /**
   * 注册一个 federated 来源的 pending request。
   *
   * 协调 master / member 收到 FedDeliver 投到本地 agent 之前调用。
   * fromAgentId 用一个 sentinel,使 ws-hub 的 sendToAgent 不会真投递到任何本地 agent
   * (实际上 ws-hub reply handler 在 isFederated 时会改走 fedReplyHook,不会 sendToAgent)。
   */
  registerFederatedPendingRequest(
    requestId: string,
    conversation?: import("../shared/protocol.js").ConversationContext,
  ): void {
    this.pendingRequests.set(requestId, {
      fromAgentId: FEDERATED_REPLY_MARKER,
      createdAt: Date.now(),
      conversation,
      isFederated: true,
    });
  }

  /** 消费并清掉一个 federated pending request(成功 dispatch reply 后调用) */
  consumeFederatedPendingRequest(requestId: string): boolean {
    return this.pendingRequests.delete(requestId);
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
    requestId?: string,
    payload?: { message: string; files?: Array<{ name: string; uri: string }> },
  ): RouteResult {
    // 1. 本机 agent 查询(优先 hostname 复合键,fallback 全局 name)
    const target = this.db.getLocalAgentByName(targetName)
      ?? this.db.getAgentByName(targetName) as any;
    if (target) {
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

    // 2. 本机找不到 → 走 federation 路由(如果配了)
    if (this.fedClient && this.teamId && requestId && payload) {
      const fedResult = this.routeFederated(fromName, targetName, requestId, payload, summary);
      if (fedResult) return fedResult;
    }

    this.db.audit({ fromName, fromDomain, toName: targetName, routeType: "exact", result: "failed", messageSummary: summary });
    return { delivered: false, queued: false, error: `Agent "${targetName}" not found` };
  }

  /**
   * 跨 master 路由:解析 targetName(alice@hostB 或裸 alice)→ 查 agent_visibility
   * → 调 federationClient.route 发 FedRouteMessage。
   */
  private routeFederated(
    fromName: string,
    targetName: string,
    requestId: string,
    payload: { message: string; files?: Array<{ name: string; uri: string }> },
    summary: string,
  ): RouteResult | null {
    if (!this.fedClient || !this.teamId || !this.localHostname) return null;

    const ref = parseAgentRef(targetName);
    let targetMasterId: string | undefined;
    let targetHostname: string | undefined;

    if (ref.hostname && ref.hostname !== this.localHostname) {
      // 形如 "alice@hostB" → 按 (hostname, name) 反查
      const vis = this.db.findVisibleAgentByHostAndName(this.teamId, ref.hostname, ref.name);
      if (!vis) return null;
      targetMasterId = vis.master_id;
      targetHostname = vis.hostname;
    } else {
      // 裸 name → 按 name 反查(department 内必须唯一)
      const candidates = this.db.findVisibleAgentsByName(this.teamId, ref.name);
      if (candidates.length === 0) return null;
      if (candidates.length > 1) {
        this.db.audit({ fromName, toName: targetName, routeType: "federated", result: "failed", messageSummary: `ambiguous: ${candidates.length} matches` });
        return { delivered: false, queued: false, error: `Ambiguous agent "${ref.name}" across masters (use name@hostname)` };
      }
      targetMasterId = candidates[0].master_id;
      targetHostname = candidates[0].hostname;
    }

    // 发 FedRouteMessage 给协调 master(由协调 master 转 FedDeliver)
    const ok = this.fedClient.route(
      requestId,
      { hostname: this.localHostname, name: fromName },
      { hostname: targetHostname!, name: ref.name },
      { message: payload.message, files: payload.files as FedRouteDeliver["payload"]["files"] },
    );

    if (!ok) {
      return { delivered: false, queued: false, error: "Federation client not connected" };
    }

    this.db.audit({
      fromName,
      toName: `${ref.name}@${targetHostname}`,
      routeType: "federated",
      result: "routed",
      messageSummary: summary,
    });
    // delivered=true 告诉 WSHub 不要再尝试本地投递
    return { delivered: true, queued: false, targetName: `${ref.name}@${targetHostname}` };
  }

}
