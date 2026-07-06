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
  PENDING_REQUEST_TTL_MS,
  CLEANUP_INTERVAL_MS,
} from "../../shared/constants.js";
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
  type FedRouteFailed,
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
  /**
   * `rotom ask` 跨机路径专用:协调 master 收到带 `bridge` 字段的 FedRouteMessage 时调用。
   * 在协调 master 本地建/复用 a2a_direct pair 群 + 写 asker 提问进群 + 建 ask-bridge,
   * 返回 { bridgeId, groupId } 挂到 pendingFedRequests,供 reply 时反查。
   *
   * mode="async" 时,reply 到达时协调 master 调 onBridgeReply 写群+resolve bridge;
   * mode="async" 的超时由 scheduler ask-bridge-check 处理(沿用 #reply 路径)。
   */
  createBridgeForRoute?: (msg: FedRouteMessage) => { bridgeId: string; groupId: string } | null;
  /**
   * `rotom ask` 跨机路径的 reply 钩子:协调 master 收到 FedRouteReply,
   * 若该 requestId 有 bridge,调此 hook 写进 pair 群 + resolve bridge。
   */
  onBridgeReply?: (requestId: string, bridgeId: string, groupId: string, asker: string, target: string, replyMessage: string) => void;
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
  /**
   * requestId → 来源 member 的 masterId。
   *
   * FedRouteMessage 入口注册,FedReply 到达时按 requestId 反查 → 只发给来源 member(精确路由)。
   * 取代 Phase 2 的广播兜底,避免 member 多了被 reply 噪声淹没 + 隐私泄漏。
   * 失败出口(sendRouteFailed)和 reply 成功出口都 delete;TTL 兜底由 cleanupTimer 清。
   */
  private pendingFedRequests = new Map<string, {
    sourceMasterId: string;
    createdAt: number;
    /** 若该请求是 `rotom ask` 跨机路径(reply 时协调 master 写进 pair 群 + resolve bridge),则记录 bridgeId+groupId */
    bridge?: { bridgeId: string; groupId: string; asker: string; target: string };
  }>();
  private cleanupTimer?: NodeJS.Timeout;
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
    // 60s 清理超时的 pendingFedRequests(对齐 Router.cleanupTimer 模式)
    this.cleanupTimer = setInterval(() => this.cleanupPendingFedRequests(), CLEANUP_INTERVAL_MS);
    log.info(`[fed-server] listening on /federation (teamId=${this.opts.teamId})`);
  }

  private cleanupPendingFedRequests(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingFedRequests) {
      if (now - entry.createdAt > PENDING_REQUEST_TTL_MS) {
        this.pendingFedRequests.delete(id);
      }
    }
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.pendingFedRequests.clear();
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

    // 重投该 member 离线期间暂存的 fed 消息(Phase 3 离线暂存重投)
    this.replayOfflineFedMessages(msg.masterId);

    return { accepted: true, masterId: msg.masterId };
  }

  /**
   * 把 member 离线期间暂存的 FedDeliver 批量重投过去。
   *
   * 暂存由 forwardDeliver 在 target member 离线时调 enqueueFedOffline 写入。
   * member 重连(握手成功)后立即重投 —— 顺序按 created_at,最早的先投。
   * 单条重投失败(WS 又断了)→ 不回暂存,丢了;后续 reply 路由会 TTL 超时,member 端 PendingRequests 也同步超时。
   */
  private replayOfflineFedMessages(masterId: string): void {
    const rows = this.db.popFedOfflineByMaster(masterId);
    if (rows.length === 0) return;
    log.info(`[fed-server] replaying ${rows.length} offline fed messages to ${masterId}`);
    for (const row of rows) {
      try {
        const deliver = JSON.parse(row.payload) as FedRouteDeliver;
        const ok = this.sendToMember(masterId, deliver);
        if (!ok) {
          log.warn(`[fed-server] replay deliver failed (member WS gone again?) requestId=${deliver.requestId}`);
          break; // member 又断了,后面的也不投了
        }
      } catch (e) {
        log.warn(`[fed-server] replay parse failed for offline id=${row.id}: ${(e as Error).message}`);
      }
    }
  }

  private async handleFedMessage(msg: FedMessage, fromMasterId: string): Promise<void> {
    switch (msg.type) {
      case "fed_agent_publish":
        return this.handleAgentPublish(msg as FedAgentPublish, fromMasterId);
      case "fed_agent_unpublish":
        return this.handleAgentUnpublish(msg as FedAgentUnpublish);
      case "fed_route":
        return this.handleRouteMessage(msg as FedRouteMessage, fromMasterId);
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

  private handleRouteMessage(msg: FedRouteMessage, fromMasterId: string): void {
    // 记录来源 member,供 FedReply 精确路由回来源(取代广播)
    const entry: { sourceMasterId: string; createdAt: number; bridge?: { bridgeId: string; groupId: string; asker: string; target: string } } = {
      sourceMasterId: fromMasterId,
      createdAt: Date.now(),
    };

    // `rotom ask` 跨机路径:若 msg.bridge 存在,协调 master 本地建/复用 pair 群 + 写提问进群 + 建 bridge
    if (msg.bridge && this.handlers.createBridgeForRoute) {
      const created = this.handlers.createBridgeForRoute(msg);
      if (created) {
        entry.bridge = {
          bridgeId: created.bridgeId,
          groupId: created.groupId,
          asker: msg.bridge.asker,
          target: msg.bridge.target,
        };
      }
    }
    this.pendingFedRequests.set(msg.requestId, entry);

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
      this.sendRouteFailed(fromMasterId, msg, "NOT_FOUND");
      return;
    }
    this.forwardDeliver(visible.master_id, msg);
  }

  /**
   * 给发起方 member / link 回 FedRouteFailed。
   *
   * 何时调用:
   *   - handleRouteMessage 找不到目标 agent(NOT_FOUND)
   *   - (后续)forwardDeliver 暂存失败或目标永久不可达(OFFLINE_DROPPED,Phase 4)
   * 成功发送后删 pendingFedRequests entry(避免 reply 来时再发一次)。
   * 来源 member 离线时 sendToMember 失败 → 静默丢弃(member 端 PendingRequests 自己 TTL 超时)。
   */
  private sendRouteFailed(
    targetMasterId: string,
    route: FedRouteMessage,
    reason: "NOT_FOUND" | "OFFLINE_DROPPED",
  ): void {
    const msg: FedRouteFailed = {
      type: "fed_route_failed",
      requestId: route.requestId,
      reason,
      from: route.from,
      to: route.to,
    };
    const ok = this.sendToMember(targetMasterId, msg);
    if (!ok) {
      log.warn(`[fed-server] route_failed delivery to ${targetMasterId} failed (offline?), requestId=${route.requestId}`);
    }
    this.pendingFedRequests.delete(route.requestId);
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
      // 目标 member 离线 → 暂存到 offline_messages(member 重连时 replay)
      const queued = this.db.enqueueFedOffline({
        target_master_id: targetMasterId,
        target_hostname: route.to.hostname,
        target_agent: route.to.name,
        source_master_id: this.opts.identity.id, // coord 自己记的 pendingFedRequests 用
        source_hostname: route.from.hostname,
        source_agent: route.from.name,
        payload: JSON.stringify(deliver),
        request_id: route.requestId,
      });
      if (queued) {
        log.info(`[fed-server] target member ${targetMasterId} offline, queued requestId=${route.requestId} (will replay on reconnect)`);
      } else {
        // per-member 100 条上限 → 丢老消息
        log.warn(`[fed-server] offline queue full for member ${targetMasterId}, dropping requestId=${route.requestId}`);
      }
      // 注意:pendingFedRequests 不在这里删 —— member 重投成功后会回 FedReply,届时再删。
      // route_failed 才删。
    }
  }

  private handleRouteReply(msg: FedRouteReply): void {
    // 精确路由:按 requestId 反查来源 member,只发给来源(取代广播兜底)
    const entry = this.pendingFedRequests.get(msg.requestId);
    if (!entry) {
      // TTL 超时 / 重复 reply / 协调重启后丢了 → 兜底广播,member 端没 pending 就忽略
      log.warn(`[fed-server] reply for unknown requestId=${msg.requestId} (TTL'd or already routed), broadcasting as fallback`);
      this.broadcastReply(msg);
      return;
    }
    // `rotom ask` 跨机路径:reply 到达协调 master 时,先写进 pair 群 + resolve bridge
    // (协调 master 持群),再转发给发起方 member/link。
    if (entry.bridge && this.handlers.onBridgeReply) {
      try {
        this.handlers.onBridgeReply(
          msg.requestId,
          entry.bridge.bridgeId,
          entry.bridge.groupId,
          entry.bridge.asker,
          entry.bridge.target,
          msg.payload.message,
        );
      } catch (e) {
        log.warn(`[fed-server] onBridgeReply failed for requestId=${msg.requestId}: ${(e as Error).message}`);
      }
    }
    const ok = this.sendToMember(entry.sourceMasterId, msg);
    if (!ok) {
      log.warn(`[fed-server] reply delivery to source ${entry.sourceMasterId} failed (offline?) requestId=${msg.requestId}`);
      // 来源 member 离线 → 没法投递 reply。删 entry,member 端会自己 TTL 超时。
      // 不再广播兜底(给其他 member 投也是噪声)。
    }
    this.pendingFedRequests.delete(msg.requestId);
  }

  /**
   * 协调 master 把 FedReply 发给"发起方 member"。
   *
   * 由 FederationManager.fedReplyHook 调用:本机 agent 给一个 federated 请求回了消息,
   * 把 reply 转回发起方。Phase 3 改为精确路由(查 pendingFedRequests 找 sourceMasterId);
   * 若查不到(TTL 超时 / 协调重启后丢了),兜底广播。
   */
  sendReply(
    requestId: string,
    from: { hostname: string; name: string },
    payload: { message: string },
  ): void {
    const msg: FedRouteReply = {
      type: "fed_reply",
      requestId,
      from,
      payload,
    };
    const entry = this.pendingFedRequests.get(requestId);
    if (!entry) {
      log.warn(`[fed-server] sendReply: unknown requestId=${requestId} (TTL'd or coord restart), broadcasting as fallback`);
      this.broadcastReply(msg);
      return;
    }
    // 协调 master 本机 agent 回复(`rotom ask` 跨机场景,目标在 coord 本机)→
    // 不会走 peers 的 fed_reply 入口(那是给远端 member 回来的 reply 用的),
    // 所以这里要显式触发 onBridgeReply 写 pair 群 + resolve bridge,否则
    // bridge 永远 pending、群消息只有提问没有回复。
    if (entry.bridge && this.handlers.onBridgeReply) {
      try {
        this.handlers.onBridgeReply(
          requestId,
          entry.bridge.bridgeId,
          entry.bridge.groupId,
          entry.bridge.asker,
          entry.bridge.target,
          msg.payload.message,
        );
      } catch (e) {
        log.warn(`[fed-server] onBridgeReply failed for requestId=${requestId}: ${(e as Error).message}`);
      }
    }
    const ok = this.sendToMember(entry.sourceMasterId, msg);
    if (!ok) {
      log.warn(`[fed-server] sendReply to source ${entry.sourceMasterId} failed (offline?) requestId=${requestId}`);
    }
    this.pendingFedRequests.delete(requestId);
  }

  private broadcastReply(msg: FedRouteReply): void {
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
