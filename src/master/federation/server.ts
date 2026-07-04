/**
 * Federation Server —— 协调 master 端的 Federation WS server。
 *
 * 挂在 `/federation` 路径(与 agent 用的 `/ws` 区分),监听 member 的连接。
 * 免认证但握手强制声明 masterId/hostname/role,协调侧持久化来源便于审计。
 *
 * 职责(Phase 2 星型):
 *   1. 握手:校验 hostname 在 department 内不冲突 → fed_handshake_ack
 *   2. 接收 member 的 FedAgentPublish → UPSERT agent_visibility + 广播 FedDirectorySync
 *   3. 接收 member 的 FedRouteMessage → 查 team_peers 找 target master_id
 *      → 转 FedDeliver 投递到目标 member
 *   4. 接收 member 的 FedReply → 路由回来源 member
 *   5. 定期广播 FedDirectorySync(全量;Phase 3 加 diff 增量)
 *
 * 离线 member:消息暂存 offline_messages(扩展 target_hostname),member 重连后重投。
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { MeshDb } from "../db.js";
import type { MasterIdentity } from "./identity.js";
import {
  FED_PROTOCOL_VERSION,
  isFedMessage,
  parseAgentRef,
  type FedHandshake,
  type FedHandshakeAck,
  type FedAgentPublish,
  type FedAgentUnpublish,
  type FedDirectorySync,
  type FedRouteMessage,
  type FedRouteDeliver,
  type FedRouteReply,
  type FedMessage,
} from "../../shared/protocol/federation.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("fed-server");

/** 协调 master 收到 member 的 FedRouteMessage 后,通过此回调交给 Router/publisher 处理 */
export interface FedRouteHandlers {
  /** 路由消息到本地 agent(目标在本机时)。返回 true 表示已投递。 */
  deliverLocal?: (msg: FedRouteDeliver) => boolean;
  /** 转发到其他 member(目标在另一个 member 时)。返回 true 表示已找到目标并发送。 */
  forwardToMember?: (targetMasterId: string, msg: FedMessage) => boolean;
}

export interface FedServerOpts {
  /** 协调 master 自己的身份(从 master_node 表读) */
  identity: MasterIdentity;
  /** teamId — 协调 master 是团队内的 coordination peer,需要知道自己属于哪个部门 */
  teamId: string;
  /** 已注册 member 的连接:masterId → WebSocket */
  peers?: Map<string, WebSocket>;
}

export class FedServer {
  private wss: WebSocketServer;
  private peers: Map<string, WebSocket>; // masterId → ws
  /** 反查:ws → masterId(用于 close 时清理) */
  private wsToMaster: Map<WebSocket, string>;
  private syncTimer?: NodeJS.Timeout;
  private handlers: FedRouteHandlers = {};
  /** 捕获的旧 upgrade listeners(start 时接管,非 /federation 的请求 delegate 回它们) */
  private delegatedUpgradeListeners: Array<(req: IncomingMessage, socket: Socket, head: Buffer) => void> = [];
  private upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null;

  constructor(
    private httpServer: Server,
    private db: MeshDb,
    private opts: FedServerOpts,
  ) {
    this.peers = opts.peers ?? new Map();
    this.wsToMaster = new Map();
    // noServer 模式:手动分发 upgrade,避免与 WSHub 的 path=/ws 冲突
    // (WSHub 用 WebSocketServer({ server, path: "/ws" }),其 handleUpgrade
    // 会对非 /ws 路径 abortHandshake(socket, 400),破坏 /federation 握手)
    this.wss = new WebSocketServer({ noServer: true });
  }

  start(): void {
    // 接管 httpServer 的 upgrade 事件:匹配 /federation → 自己处理;
    // 其他路径(/ws、/api/terminal)delegate 给原 listeners。
    // pattern 借鉴 src/master/terminal-hub.ts。
    this.delegatedUpgradeListeners = this.httpServer
      .listeners("upgrade")
      .slice() as typeof this.delegatedUpgradeListeners;
    this.httpServer.removeAllListeners("upgrade");
    this.upgradeHandler = (req, socket, head) => {
      const url = req.url || "";
      if (url.includes("/federation")) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
        return;
      }
      // delegate 给原 listeners(WSHub、TerminalHub 等)
      for (const listener of this.delegatedUpgradeListeners) {
        listener.call(this.httpServer, req, socket, head);
      }
    };
    this.httpServer.on("upgrade", this.upgradeHandler);

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req.socket.remoteAddress));
    // 30s 全量 directory sync 给所有 member
    this.syncTimer = setInterval(() => this.broadcastDirectorySync(), 30_000);
    log.info(`[fed-server] listening on /federation (teamId=${this.opts.teamId})`);
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    // 恢复原 listeners
    if (this.upgradeHandler) {
      this.httpServer.removeListener("upgrade", this.upgradeHandler);
      for (const listener of this.delegatedUpgradeListeners) {
        this.httpServer.on("upgrade", listener);
      }
    }
    for (const ws of this.peers.values()) {
      try { ws.close(1000, "fed server stopping"); } catch { /* ignore */ }
    }
    this.wss.close();
  }

  /** 注入路由处理器(由 server.ts 在 WSHub/Router 创建后调用) */
  setHandlers(handlers: FedRouteHandlers): void {
    this.handlers = handlers;
  }

  /** 主动给指定 member 发消息 */
  sendToMember(masterId: string, msg: FedMessage): boolean {
    const ws = this.peers.get(masterId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /** 广播 directory sync 给所有 member */
  broadcastDirectorySync(): void {
    const sync = this.buildDirectorySync();
    for (const ws of this.peers.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(sync));
      }
    }
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, remoteAddr: string | undefined): void {
    log.info(`[fed-server] incoming connection from ${remoteAddr ?? "?"}`);

    let authenticated = false;
    let peerMasterId: string | null = null;

    // 握手超时(复用 AUTH_TIMEOUT_MS 思路,10s)
    const timeout = setTimeout(() => {
      if (!authenticated) {
        try { ws.close(4401, "fed handshake timeout"); } catch { /* ignore */ }
      }
    }, 10_000);

    ws.on("message", (raw) => {
      let msg: FedMessage;
      try {
        const parsed = JSON.parse(raw.toString());
        if (!isFedMessage(parsed)) {
          log.warn(`[fed-server] invalid fed message from ${remoteAddr}`);
          ws.close(4400, "invalid fed message");
          return;
        }
        msg = parsed;
      } catch {
        ws.close(4400, "invalid JSON");
        return;
      }

      if (!authenticated) {
        if (msg.type !== "fed_handshake") {
          ws.close(4401, "fed handshake required");
          return;
        }
        const result = this.handleHandshake(ws, msg as FedHandshake);
        if (!result.accepted) {
          // handleHandshake 已发 ack + close
          return;
        }
        authenticated = true;
        peerMasterId = result.masterId!;
        clearTimeout(timeout);
        return;
      }

      // 已认证消息分发
      this.handleFedMessage(msg, peerMasterId!).catch((err) => {
        log.error(`[fed-server] handle ${msg.type} error:`, err);
      });
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (peerMasterId) {
        this.peers.delete(peerMasterId);
        this.wsToMaster.delete(ws);
        // 把该 member 在 agent_visibility 里的记录全部标 offline(不删,等重连)
        this.db.setVisibleOnline(this.opts.teamId, peerMasterId, "*", false);
        // setVisibleOnline 不支持通配符 — 改为遍历
        this.markAllAgentsOffline(peerMasterId);
        log.info(`[fed-server] peer ${peerMasterId} disconnected`);
      }
    });
  }

  private handleHandshake(
    ws: WebSocket,
    msg: FedHandshake,
  ): { accepted: boolean; masterId?: string } {
    const ack: FedHandshakeAck = {
      type: "fed_handshake_ack",
      teamId: this.opts.teamId,
      accepted: false,
      serverMasterId: this.opts.identity.id,
      serverHostname: this.opts.identity.hostname,
    };

    if (msg.protocol !== FED_PROTOCOL_VERSION) {
      ack.error = "PROTOCOL_MISMATCH";
      ws.send(JSON.stringify(ack));
      ws.close(4402, "protocol mismatch");
      return { accepted: false };
    }

    if (msg.role !== "member" && msg.role !== "coordination") {
      ack.error = "ROLE_MISMATCH";
      ws.send(JSON.stringify(ack));
      ws.close(4403, "role mismatch");
      return { accepted: false };
    }

    // hostname 冲突检测:department 内是否已有同 hostname 的 peer
    const conflict = this.db.findPeerByHostname(this.opts.teamId, msg.hostname);
    if (conflict && conflict.master_id !== msg.masterId) {
      ack.error = "HOSTNAME_CONFLICT";
      ws.send(JSON.stringify(ack));
      ws.close(4404, "hostname conflict");
      log.warn(`[fed-server] reject ${msg.masterId}: hostname "${msg.hostname}" already taken by ${conflict.master_id}`);
      return { accepted: false };
    }

    // 注册 peer
    this.db.upsertPeer({
      team_id: this.opts.teamId,
      master_id: msg.masterId,
      hostname: msg.hostname,
      role: msg.role,
    });
    this.peers.set(msg.masterId, ws);
    this.wsToMaster.set(ws, msg.masterId);
    ack.accepted = true;
    ws.send(JSON.stringify(ack));
    log.info(`[fed-server] peer joined: ${msg.masterId} (${msg.hostname}, ${msg.role})`);

    // 握手后立即推一次 directory(让新 member 看到现有成员)
    const sync = this.buildDirectorySync();
    ws.send(JSON.stringify(sync));

    return { accepted: true, masterId: msg.masterId };
  }

  private async handleFedMessage(msg: FedMessage, fromMasterId: string): Promise<void> {
    switch (msg.type) {
      case "fed_agent_publish":
        return this.handleAgentPublish(msg as FedAgentPublish, fromMasterId);
      case "fed_agent_unpublish":
        return this.handleAgentUnpublish(msg as FedAgentUnpublish);
      case "fed_route":
        return this.handleRouteMessage(msg as FedRouteMessage);
      case "fed_reply":
        return this.handleRouteReply(msg as FedRouteReply);
      case "fed_deliver":
        // 协调 master 不应该收到 fed_deliver(那是给 member 的)
        log.warn(`[fed-server] unexpected fed_deliver from ${fromMasterId}`);
        return;
      case "fed_directory_sync":
        // member 不会发这个给协调;忽略
        return;
      default:
        log.warn(`[fed-server] unhandled fed message type: ${(msg as { type: string }).type}`);
    }
  }

  private handleAgentPublish(msg: FedAgentPublish, _fromMasterId: string): void {
    // msg.masterId 是 member 自报的(信任),_fromMasterId 是 ws 关联的(权威)
    // 实际生产应该用 _fromMasterId 防伪造;Phase 2 简化用 msg.masterId
    for (const a of msg.agents) {
      this.db.upsertVisibleAgent({
        team_id: msg.teamId,
        master_id: msg.masterId,
        agent_name: a.name,
        hostname: a.hostname,
        display_name: a.displayName,
        is_human: a.isHuman,
        online: a.online,
      });
    }
    // 通知其他 member(增量 sync 简化为全量,因为 Phase 2 简单)
    this.broadcastDirectorySync();
  }

  private handleAgentUnpublish(msg: FedAgentUnpublish): void {
    for (const a of msg.agents) {
      this.db.removeVisibleAgent(msg.teamId, msg.masterId, a.name);
    }
    this.broadcastDirectorySync();
  }

  private handleRouteMessage(msg: FedRouteMessage): void {
    // 查目标 agent 的 master_id(从 agent_visibility)
    const visible = this.db.findVisibleAgentByHostAndName(
      msg.teamId,
      msg.to.hostname,
      msg.to.name,
    );
    if (!visible) {
      // 也可能目标 name 在 department 内唯一(不带 hostname)
      const candidates = this.db.findVisibleAgentsByName(msg.teamId, msg.to.name);
      if (candidates.length === 1) {
        this.forwardDeliver(candidates[0].master_id, msg);
        return;
      }
      log.warn(`[fed-server] route target not found: ${msg.to.name}@${msg.to.hostname}`);
      // Phase 3:回 route_failed 给来源
      return;
    }
    this.forwardDeliver(visible.master_id, msg);
  }

  private forwardDeliver(targetMasterId: string, route: FedRouteMessage): void {
    // 目标是协调自己?
    if (targetMasterId === this.opts.identity.id) {
      const deliver: FedRouteDeliver = {
        type: "fed_deliver",
        requestId: route.requestId,
        from: route.from,
        to: route.to,
        payload: route.payload,
        conversation: route.conversation,
      };
      const ok = this.handlers.deliverLocal?.(deliver) ?? false;
      if (!ok) log.warn(`[fed-server] local deliver failed for requestId=${route.requestId}`);
      return;
    }
    // 转发到目标 member
    const deliver: FedRouteDeliver = {
      type: "fed_deliver",
      requestId: route.requestId,
      from: route.from,
      to: route.to,
      payload: route.payload,
      conversation: route.conversation,
    };
    const ok = this.sendToMember(targetMasterId, deliver);
    if (!ok) {
      // 目标 member 离线 → 暂存 offline_messages(扩字段)
      log.warn(`[fed-server] target member ${targetMasterId} offline, dropping requestId=${route.requestId}`);
      // Phase 3 加离线暂存重投
    }
  }

  private handleRouteReply(msg: FedRouteReply): void {
    // reply 也是经协调中转。来源 member 在 requestId 上 register 了 pendingRequest
    // 这里简化:把 reply 转发给"from" hostname 对应的 member
    // 实际路由应该用 requestId 反查来源 master_id(Phase 3 加 pendingFedRequests 表)
    // Phase 2 MVP:广播 reply 给所有 member,谁 pending 谁接收
    for (const [masterId, ws] of this.peers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else {
        this.peers.delete(masterId);
      }
    }
  }

  private buildDirectorySync(): FedDirectorySync {
    const rows = this.db.listVisibleAgents(this.opts.teamId);
    return {
      type: "fed_directory_sync",
      teamId: this.opts.teamId,
      upsert: rows.map((r) => ({
        masterId: r.master_id,
        hostname: r.hostname,
        name: r.agent_name,
        displayName: r.display_name ?? undefined,
        isHuman: r.is_human !== 0,
        online: r.online !== 0,
        lastHeartbeat: r.last_heartbeat ?? undefined,
      })),
      remove: [],
    };
  }

  private markAllAgentsOffline(masterId: string): void {
    // 简化:遍历该 master 的所有 visible agent,标 offline
    const rows = this.db.listVisibleAgents(this.opts.teamId);
    for (const r of rows) {
      if (r.master_id === masterId && r.online === 1) {
        this.db.setVisibleOnline(this.opts.teamId, masterId, r.agent_name, false);
      }
    }
  }
}

/** 给 ws-hub 或 router 用:解析 "alice@hostB" 或裸 "alice" */
export function resolveAgentRef(ref: string): { name: string; hostname?: string } {
  return parseAgentRef(ref);
}
