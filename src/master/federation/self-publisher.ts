/**
 * SelfPublisher —— 协调 master 把本机 agent 写入自己的 agent_visibility 表。
 *
 * 背景:FedPublisher 走 WS 把 member 的 agent 上报给协调 master,但协调
 * master 自己也跑 agent(claude/codex workers 通过 /ws 接入),这些 agent
 * 不会自动出现在 agent_visibility 里 —— 导致 link 节点(C)想直接对话协调
 * master 上的 agent 时,FedServer.findVisibleAgentByHostAndName 查不到,
 * route target not found 丢弃。
 *
 * 解法:协调 master 启动时也跑 SelfPublisher,定时把本机 online agent
 * 用 (master_id=self.id, hostname=self.hostname) 写入 agent_visibility。
 * FedServer.forwardDeliver 已有"目标是协调自己"分支(server.ts:347-354),
 * 命中后走 deliverLocal → 本地 WSHub → 本机 worker,链路打通。
 *
 * 与 FedPublisher 的区别:
 *   - FedPublisher:读 db.listAgents → 走 WS(FedClient.publish) → 协调侧 UPSERT
 *   - SelfPublisher:读 db.listAgents → 直接 db.upsertVisibleAgent(无 WS)
 */

import type { MeshDb } from "../db.js";
import type { MasterIdentity } from "./identity.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("fed-self-publisher");

const PUBLISH_INTERVAL_MS = 30_000;

export class SelfPublisher {
  private timer?: NodeJS.Timeout;

  constructor(
    private db: MeshDb,
    private identity: MasterIdentity,
  ) {}

  /** team_id 在协调侧等于 masterId(startCoordination: const teamId = identity.id) */
  private get teamId(): string {
    return this.identity.id;
  }

  start(): void {
    if (this.timer) return;
    log.info(`[fed-self-publisher] started (teamId=${this.teamId}, hostname=${this.identity.hostname})`);
    this.publishAll();
    this.timer = setInterval(() => this.publishAll(), PUBLISH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // 协调 master 停止时清掉自己发布的可见 agent,避免 stale 记录
    this.db.clearVisibleAgentsForMaster(this.teamId, this.identity.id);
    log.info("[fed-self-publisher] stopped");
  }

  /** 全量同步本机 agent 到 agent_visibility */
  publishAll(): void {
    const agents = this.db.listAgents() as Array<{
      name: string;
      status: string;
      profile?: string | null;
    }>;
    if (agents.length === 0) return;

    for (const a of agents) {
      const profile = a.profile ? JSON.parse(a.profile) as { category?: string; position?: string } : {};
      const isHuman = profile.category === "真人";
      this.db.upsertVisibleAgent({
        team_id: this.teamId,
        master_id: this.identity.id,
        agent_name: a.name,
        hostname: this.identity.hostname,
        display_name: profile.position ?? null,
        is_human: isHuman,
        online: a.status === "online",
      });
    }
  }
}
