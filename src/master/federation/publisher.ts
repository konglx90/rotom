/**
 * Federation Publisher —— 把本机 agent 状态发布到协调 master。
 *
 * Phase 2 MVP:所有 online agent 都发布(用户接入部门就是为了协作)。
 * Phase 3 会加 agents.published_to 字段(migration 058)+ 用户显式可见性控制。
 *
 * 触发:
 *   1. 启动后立即发一次全量
 *   2. 每 30s 全量同步一次(对齐协调 master 的 agent_visibility)
 *   3. (预留)WSHub broadcastDirectory 钩子触发增量 —— Phase 3
 *
 * 真人 agent(profile.category="真人")的 isHuman=true,member 端 UI 可特殊渲染。
 */

import type { MeshDb } from "../db.js";
import type { FedClient } from "./client.js";
import { createLogger } from "../../shared/logger.js";
import { EventEmitter } from "node:events";

const log = createLogger("fed-publisher");

const PUBLISH_INTERVAL_MS = 30_000;

export interface FedPublisherOpts {
  teamId: string;
}

export class FedPublisher {
  private timer?: NodeJS.Timeout;
  /** 等 client 握手成功的轮询(握手后切到正常 30s 间隔) */
  private waitTimer?: NodeJS.Timeout;

  constructor(
    private db: MeshDb,
    private client: FedClient,
    private opts: FedPublisherOpts,
  ) {}

  start(): void {
    if (this.timer) return;
    log.info(`[fed-publisher] started (teamId=${this.opts.teamId}, interval=${PUBLISH_INTERVAL_MS}ms)`);
    // 等 client 握手成功(client.start() 是异步,刚 start 时还没 connected)
    this.waitUntilConnected();
  }

  private waitUntilConnected(): void {
    if (this.waitTimer) return;
    this.waitTimer = setInterval(() => {
      if (this.client.isConnected()) {
        clearInterval(this.waitTimer!);
        this.waitTimer = undefined;
        // 握手成功 → 立即发一次 + 切到正常 30s 间隔
        this.publishAll();
        this.timer = setInterval(() => this.publishAll(), PUBLISH_INTERVAL_MS);
      }
    }, 1_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.waitTimer) {
      clearInterval(this.waitTimer);
      this.waitTimer = undefined;
    }
    // 离开时撤销所有发布(让协调 master 清掉本 master 的 agent_visibility)
    const agents = this.db.listAgents();
    if (agents.length > 0) {
      this.client.unpublish(agents.map((a) => a.name as string));
    }
    log.info("[fed-publisher] stopped");
  }

  /** 全量发布所有 online agent */
  publishAll(): void {
    if (!this.client.isConnected()) return;
    const agents = this.db.listAgents();
    if (agents.length === 0) return;

    const toPublish = agents.map((a) => {
      const profile = a.profile ? JSON.parse(a.profile) as { category?: string; position?: string } : {};
      const isHuman = profile.category === "真人";
      return {
        name: a.name as string,
        displayName: profile.position || undefined,
        isHuman,
        online: a.status === "online",
      };
    });

    const ok = this.client.publish(toPublish);
    if (!ok) {
      log.warn("[fed-publisher] publish skipped (client not connected or handshake pending)");
    }
  }
}
