/**
 * scheduler-handlers —— 定时器到点跑硬编码逻辑的 handler 注册表。
 *
 * scheduled_tasks.handler_key 非空时,scheduler.runOne 不走 prompt/agent 路径,
 * 而是查这个 registry 找对应 handler 跑。handler 接收 payload(JSON 解析后) +
 * ctx(db / hub),自行决定做什么(查 DB、发消息、建 Issue、cancel 别的 task...)。
 *
 * 这是"定时器模板"机制:不同业务场景注册不同 handler,共用同一套调度基础设施
 * (scheduler tick、at-most-once、grace window、Dashboard 可见)。
 *
 * 当前注册的 handler:
 *   - ask-bridge-check:ask-bridge 超时检查,见 docs/ASK_BRIDGE_GUIDE.md
 *
 * 未来可加:
 *   - issue-stale-check:Issue 长时间无进展自动告警
 *   - agent-offline-alert:agent 离线超阈值通知真人
 *   - collab-round-advance:协作 Issue 超时自动推进轮次
 */

import { randomUUID } from "node:crypto";
import type { MeshDb } from "./db.js";
import type { SchedulerHub } from "./scheduler.js";
import { resolveGroupAgentWorkingDir } from "./group-paths.js";
import { createLogger } from "../shared/logger.js";
import { TIMER_PERSONA_NAME } from "./util/persona.js";

const log = createLogger("mesh-scheduler-handlers");

export interface HandlerContext {
  db: MeshDb;
  hub: SchedulerHub;
}

export interface HandlerResult {
  status: "ok" | "error" | "skipped";
  error?: string;
  /** 若 handler 创建了 Issue(如 ask-bridge 升级路径),记录 issue_id 便于审计。 */
  issueId?: string;
}

export type ScheduledTaskHandler = (payload: unknown, ctx: HandlerContext) => Promise<HandlerResult> | HandlerResult;

const registry: Record<string, ScheduledTaskHandler> = {};

export function registerSchedulerHandler(key: string, handler: ScheduledTaskHandler): void {
  registry[key] = handler;
  log.info(`handler registered: ${key}`);
}

export function getSchedulerHandler(key: string): ScheduledTaskHandler | undefined {
  return registry[key];
}

// ── ask-bridge-check handler ───────────────────────────────────────────────

/**
 * ask-bridge 定时检查。每 20s 跑一次(interval 任务),payload: { bridgeId }。
 *
 * 每次 tick 检查三条路径:
 *   1. bridge 已 resolved(answered/cancelled/timed_out)→ skip,handler 应已 disable task
 *   2. B 有回复 → mark answered + disable task。复述按 reply.mentions 分流:
 *      - reply 已 @ asker → A 已被 raw @ 唤醒,跳过 system 复述(避免重复提醒)
 *      - reply 未 @ asker → postSystemToGroup 复述给 A(20s poll 兜底,raw @ 没触发)
 *   3. expires_at < now(5min 到)→ 创建升级 Issue + mark timed_out + disable task
 *   4. 都没命中 → return ok,等下个 20s tick
 *
 * ws-hub 事件式 @ 检测仍在(即时 cancel + disable task),handler 的 @ 检测是兜底。
 * 非@回复只能靠 handler 这个 20s poll 检测(20s 内必达)。
 */
registerSchedulerHandler("ask-bridge-check", async (payload, ctx) => {
  const p = payload as { bridgeId?: string };
  if (!p.bridgeId) return { status: "error", error: "missing bridgeId in payload" };

  const bridge = ctx.db.getAskBridge(p.bridgeId);
  if (!bridge) return { status: "error", error: `bridge ${p.bridgeId} not found` };
  if (bridge.status !== "pending") {
    // 已 resolved —— task 应该已被 disable。若还在跑,disable 一下兜底。
    cancelBridgeTask(ctx, bridge.id);
    return { status: "skipped", error: `bridge already ${bridge.status}` };
  }

  const now = Date.now();

  // 1. 查 B 是否有回复(@ 或非@都算,取最新一条)
  const reply = ctx.db.findLatestReplyForBridge(bridge);
  if (reply) {
    // 有回复 → mark answered + disable task。是否发 system 复述看 reply 是否已 @ asker:
    //   - 已 @ → A 已被 raw @ 唤醒,不复述(避免重复提醒,西花 06-28 反馈)
    //   - 未 @ → 走 system 复述唤醒 A(20s poll 兜底路径)
    // mentions 从 content 重抽(不信任 DB 行的 mentions 列:agent a2a_reply 入库写死 [])
    ctx.db.markBridgeAnswered(bridge.id, reply.id);
    cancelBridgeTask(ctx, bridge.id);
    const replyMentions = (reply.content || "").match(/@([\w一-鿿][\w.一-鿿-]*)/g)?.map((m: string) => m.slice(1)) ?? [];
    if (replyMentions.includes(bridge.asker)) {
      log.info(`bridge #${bridge.id} answered by handler: ${bridge.target} replied (msg ${reply.id}) already @ ${bridge.asker}, skip restatement`);
      return { status: "ok" };
    }
    const questionContent = ctx.db.getGroupMessageContent(bridge.question_msg_id) || "(原问题已删除)";
    const qSnippet = questionContent.slice(0, 200);
    const replySnippet = reply.content.slice(0, 500);
    const msg =
      `@${bridge.asker} ${TIMER_PERSONA_NAME} 来汇报: ${bridge.target} 在 ${reply.created_at} 回复了你之前的提问:\n` +
      `你问: ${qSnippet}\n` +
      `${bridge.target} 回复: ${replySnippet}\n` +
      `\n` +
      `**下一步**:基于这条回复继续你之前的任务。如果你不记得任务上下文(新 session),**立即跑 \`rotom group history ${bridge.group_id} --limit 10\`**,找到你问之前是谁 @ 你的、他们让你做什么,然后把 ${bridge.target} 的回复告诉那个人。`;
    ctx.hub.postSystemToGroup(bridge.group_id, msg);
    log.info(`bridge #${bridge.id} answered by handler: ${bridge.target} replied (msg ${reply.id}), restated to ${bridge.asker} (no @ in reply)`);
    return { status: "ok" };
  }

  // 2. 超时(5min 到,无回复)→ 创建升级 Issue + disable task
  if (bridge.expires_at < now) {
    const issueId = randomUUID();
    const questionContent = ctx.db.getGroupMessageContent(bridge.question_msg_id) || "(原问题已删除)";
    const qSnippet = questionContent.slice(0, 200);
    const createdIso = new Date(bridge.created_at).toISOString();
    const minutes = Math.max(1, Math.round(bridge.timeout_ms / 60_000));
    const escalateTo = resolveEscalateTo(ctx, bridge);
    const title = `[ask-bridge] ${bridge.target} 未回复,需升级`;
    const description = [
      `${TIMER_PERSONA_NAME} 等了 ${minutes} 分钟没等到 ${bridge.target},触发升级:`,
      `你于 ${createdIso} 在群 "${bridge.group_id}" 问 ${bridge.target}:`,
      `  "${qSnippet}"`,
      ``,
      escalateTo
        ? `请去群里 @ ${escalateTo} 求救,说明:`
        : `群里当前没有在线的真人。请在群里说明情况,等真人上线后跟进。`,
      `- 你问的是什么`,
      `- 等了多久`,
      `- 你尝试过什么(如有)`,
      ``,
      `求救后 rotom issue complete ${issueId} 关闭此 Issue。`,
    ].join("\n");

    ctx.db.createIssue({
      id: issueId,
      groupId: bridge.group_id,
      title,
      description,
      createdBy: "system:ask-bridge",
      workingDir: resolveGroupAgentWorkingDir(ctx.db, bridge.group_id, bridge.asker),
      assignedTo: bridge.asker,
    });
    ctx.db.markBridgeTimedOut(bridge.id, issueId, null);
    cancelBridgeTask(ctx, bridge.id);
    const pushed = ctx.hub.pushIssueAssignment(issueId, bridge.asker);
    if (!pushed) {
      log.warn(`bridge #${bridge.id} pushIssueAssignment to ${bridge.asker} failed (offline?)`);
    }
    log.info(`bridge #${bridge.id} timed_out by handler: issue ${issueId} → ${bridge.asker} (no reply, escalate)`);
    return { status: "ok", issueId };
  }

  // 3. 都没命中 → 等 5min 内的下个 20s tick
  return { status: "ok" };
});

/** cancel 对应 bridgeId 的 ask-bridge scheduled_task(disable,保留在列表里做审计)。
 *  按 handler_key + handler_payload 查,不依赖 name(name 已改成"星期五 · …"友好文案)。 */
function cancelBridgeTask(ctx: HandlerContext, bridgeId: string): void {
  const task = ctx.db.findAskBridgeScheduledTask(bridgeId);
  if (task && task.enabled) {
    ctx.db.disableScheduledTask(task.id);
    log.info(`bridge ${bridgeId}: cancelled schedule task #${task.id}`);
  }
}

/**
 * 解析超时升级的求救对象。
 *
 * 优先级:
 *   1. bridge.escalate_to 显式指定 —— 直接用
 *   2. 群里在线真人(群成员 profile override 或全局 agent profile 里 category=真人,
 *      且 status=online,且不是 asker 自己)—— 返回 "名字1 或 名字2"
 *   3. 没有在线真人 —— 返回 null(调用方给另一套文案,不让 asker LLM 自己挑,
 *      否则它会乱猜 agent 当真人,见 issue bcb92df5)
 */
function resolveEscalateTo(ctx: HandlerContext, bridge: { group_id: string; escalate_to: string | null; asker: string }): string | null {
  if (bridge.escalate_to) return bridge.escalate_to;
  const members = ctx.db.getGroupMembers(bridge.group_id);
  const agentByName = new Map<string, { status: string; profile: string | null }>();
  for (const a of ctx.db.listAgents() as Array<{ name: string; status: string; profile: string | null }>) {
    agentByName.set(a.name, a);
  }
  const humans: string[] = [];
  for (const m of members) {
    if (m.agent_name === bridge.asker) continue;
    const agent = agentByName.get(m.agent_name);
    if (!agent || agent.status !== "online") continue;
    // category 优先取群成员 profile override,回落到全局 agent profile
    let category: string | undefined;
    if (m.profile) {
      try {
        const p = JSON.parse(m.profile) as { category?: string };
        if (typeof p.category === "string") category = p.category;
      } catch { /* fall through */ }
    }
    if (!category && agent.profile) {
      try {
        const p = JSON.parse(agent.profile) as { category?: string };
        if (typeof p.category === "string") category = p.category;
      } catch { /* ignore */ }
    }
    if (category === "真人") humans.push(m.agent_name);
  }
  if (humans.length === 0) return null;
  return humans.join(" 或 ");
}
