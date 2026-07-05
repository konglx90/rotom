/**
 * FederationManager —— federation 子系统的运行时管理器。
 *
 * 把 fedClient / fedPublisher / fedServer 的创建/启动/停止封装在一起,
 * 让 API 层(POST /api/teams/join / leave)能在 master 运行时切换 federation 状态,
 * 不需要重启 master。
 *
 * 生命周期:
 *   - initFromRole():master 启动时调用,根据 identity.role 启动对应子系统
 *   - joinTeam(teamId, coordEndpoints):runtime 从 standalone 切到 member
 *   - leaveTeam():runtime 从 member 切回 standalone
 *
 * 单例:server.ts 初始化一次,API 层通过 getFederationManager() 访问。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import type { Router } from "../router.js";
import type { MasterIdentity } from "./identity.js";
import { FedServer } from "./server.js";
import { FedClient } from "./client.js";
import { FedPublisher } from "./publisher.js";
import { SelfPublisher } from "./self-publisher.js";
import { createLogger } from "../../shared/logger.js";
import { extractMentions } from "../../shared/mention.js";

const log = createLogger("fed-manager");

export interface FederationManagerOpts {
  db: MeshDb;
  hub: WSHub;
  router: Router;
  httpServer: Server;
  identity: MasterIdentity;
  rotomHome: string;
  masterPort: number;
}

export class FederationManager {
  private fedClient: FedClient | null = null;
  private fedPublisher: FedPublisher | null = null;
  private fedServer: FedServer | null = null;
  private fedSelfPublisher: SelfPublisher | null = null;

  constructor(private opts: FederationManagerOpts) {}

  /** Master 启动时调用:根据 identity.role + team.json 启动对应子系统 */
  initFromRole(): void {
    const { identity, db, hub, router, httpServer, rotomHome, masterPort } = this.opts;

    if (identity.role === "member") {
      const teamConfigPath = path.join(rotomHome, "team.json");
      if (fs.existsSync(teamConfigPath)) {
        this.startMember(JSON.parse(fs.readFileSync(teamConfigPath, "utf-8")));
      } else {
        log.warn(`role=member but no ${teamConfigPath} — falling back to standalone`);
      }
    } else if (identity.role === "coordination") {
      this.startCoordination();
    }
  }

  /** Runtime:从 standalone 切到 member,连协调 master */
  async joinTeam(input: { coordEndpoint: string; teamName?: string }): Promise<{ teamId: string; teamName: string }> {
    if (this.fedClient) {
      throw new Error("Already a member of a team — leave first");
    }
    const { identity, db, hub, router, rotomHome } = this.opts;

    // 1. 连协调 master,握手拿 teamId(协调的 masterId)
    const teamId = await this.fetchCoordIdentity(input.coordEndpoint);
    const teamName = input.teamName || `团队@${identity.hostname}`;

    // 2. 写 team.json
    const teamConfigPath = path.join(rotomHome, "team.json");
    fs.writeFileSync(
      teamConfigPath,
      JSON.stringify({
        id: teamId,
        name: teamName,
        coord_endpoints: [input.coordEndpoint],
      }, null, 2) + "\n",
      "utf-8",
    );

    // 3. 建本地 team 行(本机视角)
    if (!db.getTeam(teamId)) {
      db.insertTeam({
        id: teamId,
        name: teamName,
        my_role: "member",
        coord_endpoints: input.coordEndpoint,
      });
    }

    // 4. 启动 fedClient + fedPublisher
    this.startMember({ id: teamId, name: teamName, coord_endpoints: [input.coordEndpoint] });

    return { teamId, teamName };
  }

  /** Runtime:离开团队,切回 standalone */
  leaveTeam(): void {
    const { rotomHome, db, router } = this.opts;

    // 停 fedClient + fedPublisher
    this.fedPublisher?.stop();
    this.fedClient?.stop();
    this.fedPublisher = null;
    this.fedClient = null;

    // 撤回 Router 的 federation 注入
    // (setFederation 接受 undefined?不,签名要求 client。简单起见用类型断言)
    (router as unknown as { fedClient: unknown; teamId: unknown; localHostname: unknown }).fedClient = undefined;
    (router as unknown as { teamId: unknown }).teamId = undefined;

    // 删 team.json
    const teamConfigPath = path.join(rotomHome, "team.json");
    try { fs.unlinkSync(teamConfigPath); } catch { /* 不存在 */ }

    // 清本地 team 行 + peer 缓存 + agent_visibility 缓存
    const teams = db.listTeams();
    for (const t of teams) {
      if (t.my_role === "member") {
        db.clearPeers(t.id);
        db.clearVisibleAgents(t.id);
        db.deleteTeam(t.id);
      }
    }

    log.info("Left team — back to standalone");
  }

  getRole(): MasterIdentity["role"] {
    return this.opts.identity.role;
  }

  getFedClient(): FedClient | null {
    return this.fedClient;
  }

  // ─── 内部 ─────────────────────────────────────────────────────────────

  /** 拉协调 master 的 /api/identity 拿 masterId(作 teamId) */
  private async fetchCoordIdentity(coordEndpoint: string): Promise<string> {
    const httpUrl = coordEndpoint
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/$/, "");
    const res = await fetch(`${httpUrl}/api/identity`);
    if (!res.ok) {
      throw new Error(`Failed to fetch coord identity: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as { id: string; role: string };
    if (data.role !== "coordination") {
      throw new Error(`Target master is not a coordination master (role=${data.role})`);
    }
    return data.id;
  }

  private startMember(teamCfg: { id: string; name?: string; coord_endpoints: string[] }): void {
    const { identity, db, hub, router } = this.opts;

    this.fedClient = new FedClient(db, {
      identity,
      coordEndpoints: teamCfg.coord_endpoints,
      teamId: teamCfg.id,
      role: "member",
    });
    this.fedClient.setHandlers({
      deliverLocal: (msg) => {
        const target = db.getLocalAgentByName(msg.to.name) ?? db.getAgentByName(msg.to.name);
        if (!target) return false;
        const fromAgent = db.getAgentByName(msg.from.name);
        const fromInfo = {
          name: msg.from.name,
          status: "online" as const,
          domain: fromAgent?.domain ?? undefined,
          description: fromAgent?.description ?? undefined,
          enabled: (fromAgent?.enabled ?? 1) !== 0,
        };
        // 注册 federated pending request,让本地 agent 的 a2a_reply 走 fedReplyHook
        router.registerFederatedPendingRequest(msg.requestId, msg.conversation as never);
        return hub.sendToAgent(target.id as string, {
          type: "a2a_message",
          requestId: msg.requestId,
          from: fromInfo,
          payload: msg.payload as never,
          routeType: "federated",
          conversation: msg.conversation as never,
        });
      },
      handleReply: (msg) => {
        const targetId = router.resolveReplyTarget(msg.requestId);
        if (!targetId) return;
        hub.sendToAgent(targetId, {
          type: "a2a_reply",
          requestId: msg.requestId,
          from: msg.from.name,
          payload: msg.payload,
        } as never);
      },
      handleRouteFailed: (msg) => {
        // Member 端发起跨机请求(本机 alice 经 fedClient.route 给 B 上 carol)失败时,
        // 把失败当作 a2a_reply 回给本机 alice,让 CLI/worker 拿到错误。
        // 注意:这里 router.pendingRequests 里 entry 是 isFederated=false(本机发起,
        // 不是远端投来),所以不用 consumeFederatedPendingRequest。
        // MVP:member 起发起跨机请求是 Phase 4 群组跨机场景,这里先 log + reject 思路 stub。
        log.warn(
          `[fed-manager] route_failed for requestId=${msg.requestId} reason=${msg.reason} ` +
          `to=${msg.to?.name}@${msg.to?.hostname} — Phase 4 才接 member 端 PendingRequests reject`,
        );
      },
    });
    this.fedClient.start();
    router.setFederation(this.fedClient, teamCfg.id, identity.hostname);
    // 本地 agent 给 federated 请求回复 → 通过 fedClient 把 FedReply 发给协调 master
    router.fedReplyHook = (requestId, fromName, payload) => {
      if (!this.fedClient) return;
      this.fedClient.reply(requestId, { hostname: identity.hostname, name: fromName }, payload);
      router.consumeFederatedPendingRequest(requestId);
    };

    this.fedPublisher = new FedPublisher(db, this.fedClient, { teamId: teamCfg.id });
    this.fedPublisher.start();

    log.info(`Started member mode — team=${teamCfg.id}, endpoints=${teamCfg.coord_endpoints.join(",")}`);
  }

  private startCoordination(): void {
    const { identity, db, httpServer, masterPort, router } = this.opts;
    const teamId = identity.id;
    const teamName = identity.teamName || `${identity.hostname} 团队`;

    if (!db.getTeam(teamId)) {
      db.insertTeam({
        id: teamId,
        name: teamName,
        my_role: "coordination",
        coord_endpoints: `ws://${identity.hostname}:${masterPort}`,
      });
    }
    db.upsertPeer({
      team_id: teamId,
      master_id: identity.id,
      hostname: identity.hostname,
      role: "coordination",
    });

    this.fedServer = new FedServer(httpServer, db, { identity, teamId });
    this.fedServer.setHandlers({
      deliverLocal: (msg) => {
        const { hub, db, router } = this.opts;
        const target = db.getLocalAgentByName(msg.to.name) ?? db.getAgentByName(msg.to.name);
        if (!target) return false;
        const fromAgent = db.getAgentByName(msg.from.name);
        const fromInfo = {
          name: msg.from.name,
          status: "online" as const,
          domain: fromAgent?.domain ?? undefined,
          description: fromAgent?.description ?? undefined,
          enabled: (fromAgent?.enabled ?? 1) !== 0,
        };
        // 注册 federated pending request,让本地 agent 的 a2a_reply 走 fedReplyHook
        router.registerFederatedPendingRequest(msg.requestId, msg.conversation as never);
        return hub.sendToAgent(target.id as string, {
          type: "a2a_message",
          requestId: msg.requestId,
          from: fromInfo,
          payload: msg.payload as never,
          routeType: "federated",
          conversation: msg.conversation as never,
        });
      },
      // `rotom ask` 跨机路径:协调 master 本地建/复用 pair 群 + 写 asker 提问 + 建 bridge。
      // 调用方:fedServer.handleRouteMessage 检测 msg.bridge 时调用。
      createBridgeForRoute: (msg) => {
        if (!msg.bridge) return null;
        const { hub, db } = this.opts;
        const asker = msg.bridge.asker;
        const target = msg.bridge.target;
        // 找/建 a2a_direct pair 群(3 天 TTL 续命)
        let group = db.findActivePairGroup(asker, target);
        if (!group) group = db.createPairGroup(asker, target);
        // 写 asker 提问进群(a2a_direct 群不广播;needReply=true 触发 sendAsAgent 内部 dispatch 到 target)
        // 注意:这里 from=asker,target=msg.to.name(目标在远程,本机 master 没有这个 agent 注册)
        // sendAsAgent 会查本地 agent 找不到 target → 返回 error。
        // 所以这里 a2a_direct 群只入库消息,不通过 sendAsAgent dispatch(目标在远程,后面 forwardDeliver 会处理)。
        // 直接调 addGroupMessage + bumpGroupActivity。
        const mentionTag = `@${target}`;
        const messageBody = msg.payload.message.startsWith(mentionTag) ? msg.payload.message : `${mentionTag} ${msg.payload.message}`;
        const mentions = [target];
        const messageId = db.addGroupMessage(group.id, asker, messageBody, mentions);
        db.bumpGroupActivity(group.id);
        // 建 ask-bridge(sync 模式:CLI 端阻塞;async 模式:scheduler 超时升级 Issue)
        const bridgeId = randomUUID();
        db.createAskBridge({
          id: bridgeId,
          groupId: group.id,
          asker,
          target,
          questionMsgId: messageId,
          escalateTo: msg.bridge.escalateTo ?? null,
          timeoutMs: msg.bridge.timeoutMs,
          mode: msg.bridge.mode,
        });
        // 起 ask-bridge-check 定时任务(20s interval,scheduler 跑 reply 检测兜底;sync 模式超时不升级 Issue)
        db.createScheduledTask({
          name: `星期五 · 等待 ${target} 回复`,
          groupId: group.id,
          mode: "message",
          scheduleKind: "interval",
          intervalSec: 20,
          prompt: `星期五 每 20s 检查一次 ${target} 有没有回复 ${asker} 的问题;有回复就 resolve bridge,5 分钟 sync 模式不升级、async 模式升级 Issue。`,
          handlerKey: "ask-bridge-check",
          handlerPayload: JSON.stringify({ bridgeId, asker, target, mode: msg.bridge.mode }),
        });
        log.info(`[fed-manager] bridge created for route requestId=${msg.requestId}: bridge=${bridgeId} group=${group.id} (${asker}→${target})`);
        return { bridgeId, groupId: group.id };
      },
      // reply 到达协调 master 时写进 pair 群 + resolve bridge
      onBridgeReply: (requestId, bridgeId, groupId, asker, target, replyMessage) => {
        const { db } = this.opts;
        const mentions = extractMentions(replyMessage);
        const messageId = db.addGroupMessage(groupId, target, replyMessage, mentions);
        db.bumpGroupActivity(groupId);
        db.markBridgeAnswered(bridgeId, messageId);
        log.info(`[fed-manager] bridge ${bridgeId} resolved by reply (requestId=${requestId}, group=${groupId}, target=${target})`);
      },
    });
    this.fedServer.start();
    // 本地 agent 给 federated 请求回复 → 通过 fedServer 广播 FedReply 给所有 member
    router.fedReplyHook = (requestId, fromName, payload) => {
      if (!this.fedServer) return;
      this.fedServer.sendReply(requestId, { hostname: identity.hostname, name: fromName }, payload);
      router.consumeFederatedPendingRequest(requestId);
    };
    this.fedSelfPublisher = new SelfPublisher(db, identity);
    this.fedSelfPublisher.start();
    log.info(`Started coordination mode — team=${teamId}`);
  }

  stop(): void {
    this.fedSelfPublisher?.stop();
    this.fedPublisher?.stop();
    this.fedClient?.stop();
    this.fedServer?.stop();
  }
}

// 全局单例
let manager: FederationManager | null = null;

export function initFederationManager(opts: FederationManagerOpts): FederationManager {
  manager = new FederationManager(opts);
  return manager;
}

export function getFederationManager(): FederationManager | null {
  return manager;
}
