/**
 * Federation Client —— member master 主动连协调 master。
 *
 * Member 是 outbound 主动连接,所以**移动电脑/笔记本切网无影响**(只要协调 master
 * 地址稳定)。断网自动重连,3s backoff,最多 30s。
 *
 * 职责(Phase 2):
 *   1. 读 ~/.rotom/team.json → 启动 client
 *   2. 连协调 master(/federation 路径)
 *   3. 握手 FedHandshake → 处理 FedHandshakeAck(HOSTNAME_CONFLICT 时停止重连)
 *   4. 维护本地 agent_visibility 缓存(从 FedDirectorySync 同步)
 *   5. 提供 route() 接口给 Router 用 → 封装 FedRouteMessage 发给协调
 *   6. 提供 publish() / unpublish() 给 publisher.ts 用
 *   7. 接收 FedDeliver → 投递到本地 agent(通过 handlers.deliverLocal)
 *   8. 接收 FedReply → 路由回本地 pendingRequests
 */

import WebSocket from "ws";
import type { MeshDb } from "../db.js";
import type { MasterIdentity } from "./identity.js";
import {
  FED_PROTOCOL_VERSION,
  isFedMessage,
  type FedHandshakeAck,
  type FedDirectorySync,
  type FedRouteDeliver,
  type FedRouteReply,
  type FedMessage,
  type FedAgentRef,
  type FedConversationRef,
  type FedFileRef,
} from "../../shared/protocol/federation.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("fed-client");

/** Member 端收协调消息后的本地处理回调 */
export interface FedClientHandlers {
  /** FedDeliver 到达 → 投递到本地 agent(由 WSHub.sendToAgent 路由)。返回 true=已投递 */
  deliverLocal?: (msg: FedRouteDeliver) => boolean;
  /** FedReply 到达 → 交给本地 Router pendingRequests 解析 */
  handleReply?: (msg: FedRouteReply) => void;
}

export interface FedClientOpts {
  identity: MasterIdentity;
  /** 协调 master 端点列表(逗号分隔 → 第一个可用) */
  coordEndpoints: string[];
  /** 已加入的 teamId */
  teamId: string;
  /** 团队内角色(member) */
  role: "member" | "coordination";
}

export class FedClient {
  private ws: WebSocket | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private connected = false;
  private handshakeAccepted = false;
  private stopped = false;
  private handlers: FedClientHandlers = {};

  constructor(
    private db: MeshDb,
    private opts: FedClientOpts,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try { this.ws.close(1000, "fed client stopping"); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.handshakeAccepted = false;
  }

  setHandlers(handlers: FedClientHandlers): void {
    this.handlers = handlers;
  }

  isConnected(): boolean {
    return this.connected && this.handshakeAccepted;
  }

  /** 发消息到协调 master(握手成功后才有 ws) */
  private send(msg: FedMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.handshakeAccepted) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Router 调:把消息跨 master 投递(协调 master 中转到目标) */
  route(
    requestId: string,
    from: FedAgentRef,
    to: FedAgentRef,
    payload: { message: string; files?: FedFileRef[] },
    conversation?: FedConversationRef,
  ): boolean {
    return this.send({
      type: "fed_route",
      teamId: this.opts.teamId,
      requestId,
      from,
      to,
      payload,
      conversation,
    });
  }

  /** publisher.ts 调:上报本地 agent 状态 */
  publish(agents: Array<{ name: string; displayName?: string; isHuman: boolean; online: boolean }>): boolean {
    if (!this.handshakeAccepted) return false;
    return this.send({
      type: "fed_agent_publish",
      teamId: this.opts.teamId,
      masterId: this.opts.identity.id,
      hostname: this.opts.identity.hostname,
      agents: agents.map((a) => ({
        hostname: this.opts.identity.hostname,
        name: a.name,
        displayName: a.displayName,
        isHuman: a.isHuman,
        online: a.online,
      })),
    });
  }

  unpublish(agentNames: string[]): boolean {
    if (!this.handshakeAccepted) return false;
    return this.send({
      type: "fed_agent_unpublish",
      teamId: this.opts.teamId,
      masterId: this.opts.identity.id,
      agents: agentNames.map((name) => ({ hostname: this.opts.identity.hostname, name })),
    });
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    const endpoint = this.opts.coordEndpoints[0];
    if (!endpoint) {
      log.error("[fed-client] no coord endpoint configured");
      return;
    }
    const url = endpoint.replace(/\/$/, "") + "/federation";
    log.info(`[fed-client] connecting to ${url}...`);
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      log.error(`[fed-client] ws construct failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    this.ws.on("error", (err) => {
      log.error(`[fed-client] ws error: ${err.message}`);
    });
  }

  private handleOpen(): void {
    log.info("[fed-client] connected, sending handshake...");
    this.connected = true;
    this.handshakeAccepted = false;
    // 握手(无认证,只声明身份)
    const handshake = {
      type: "fed_handshake" as const,
      masterId: this.opts.identity.id,
      hostname: this.opts.identity.hostname,
      role: this.opts.role,
      protocol: FED_PROTOCOL_VERSION,
    };
    this.ws?.send(JSON.stringify(handshake));

    // 握手超时(10s)
    setTimeout(() => {
      if (!this.handshakeAccepted && this.ws) {
        log.warn("[fed-client] handshake timeout, closing");
        try { this.ws.close(4401, "handshake timeout"); } catch { /* ignore */ }
      }
    }, 10_000);
  }

  private handleMessage(raw: string): void {
    let msg: FedMessage;
    try {
      const parsed = JSON.parse(raw);
      if (!isFedMessage(parsed)) {
        log.warn("[fed-client] invalid fed message");
        return;
      }
      msg = parsed;
    } catch {
      log.warn("[fed-client] invalid JSON");
      return;
    }

    if (!this.handshakeAccepted) {
      if (msg.type === "fed_handshake_ack") {
        this.handleHandshakeAck(msg as FedHandshakeAck);
        return;
      }
      log.warn(`[fed-client] pre-handshake unexpected: ${msg.type}`);
      return;
    }

    switch (msg.type) {
      case "fed_directory_sync":
        return this.handleDirectorySync(msg as FedDirectorySync);
      case "fed_deliver":
        return this.handleDeliver(msg as FedRouteDeliver);
      case "fed_reply":
        return this.handleReply(msg as FedRouteReply);
      case "fed_handshake_ack":
        log.warn("[fed-client] duplicate handshake_ack, ignoring");
        return;
      default:
        // 其他类型(publish/unpublish/route)是 member → coord 方向,member 不该收到
        log.warn(`[fed-client] unexpected message type: ${(msg as { type: string }).type}`);
    }
  }

  private handleHandshakeAck(msg: FedHandshakeAck): void {
    if (!msg.accepted) {
      log.error(`[fed-client] handshake rejected: ${msg.error ?? "unknown"}`);
      if (msg.error === "HOSTNAME_CONFLICT") {
        log.error(`[fed-client] hostname "${this.opts.identity.hostname}" already taken in team — change ROTOM_HOSTNAME and restart`);
        // 不重连,等用户改 hostname
        this.stopped = true;
      }
      try { this.ws?.close(4404, msg.error ?? "rejected"); } catch { /* ignore */ }
      return;
    }
    this.handshakeAccepted = true;
    log.info(`[fed-client] joined team ${msg.teamId} (coord=${msg.serverMasterId}/${msg.serverHostname})`);
  }

  private handleDirectorySync(msg: FedDirectorySync): void {
    // 全量 upsert + remove(简单实现:Phase 3 可优化为 diff)
    if (msg.remove.length > 0) {
      // remove 需要逐条删
      for (const r of msg.remove) {
        this.db.removeVisibleAgent(msg.teamId, r.masterId, r.name);
      }
    }
    if (msg.upsert.length > 0) {
      // upsert 全量替换:简单起见,先 clear 再 insert(Phase 3 优化)
      // 注意只 clear 非本机的(本机的由 publisher 维护)
      const localMasterId = this.opts.identity.id;
      const all = this.db.listVisibleAgents(msg.teamId);
      for (const r of all) {
        if (r.master_id !== localMasterId) {
          this.db.removeVisibleAgent(msg.teamId, r.master_id, r.agent_name);
        }
      }
      for (const u of msg.upsert) {
        if (u.masterId === localMasterId) continue; // 不缓存自己
        this.db.upsertVisibleAgent({
          team_id: msg.teamId,
          master_id: u.masterId,
          agent_name: u.name,
          hostname: u.hostname,
          display_name: u.displayName,
          is_human: u.isHuman,
          online: u.online,
        });
      }
    }
  }

  private handleDeliver(msg: FedRouteDeliver): void {
    const ok = this.handlers.deliverLocal?.(msg) ?? false;
    if (!ok) {
      log.warn(`[fed-client] local deliver failed for requestId=${msg.requestId}`);
    }
  }

  private handleReply(msg: FedRouteReply): void {
    this.handlers.handleReply?.(msg);
  }

  private handleClose(code: number, reason: string): void {
    this.connected = false;
    this.handshakeAccepted = false;
    this.ws = null;
    log.info(`[fed-client] disconnected (code=${code}, reason=${reason})`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
  }
}
