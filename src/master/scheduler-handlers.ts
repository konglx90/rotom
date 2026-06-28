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
 *   2. B 有回复(@ 或非@)→ mark answered + postSystemToGroup 复述给 A + disable task
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
    // 有回复 → mark answered + system @ 复述(轻量,不建 Issue) + disable task
    ctx.db.markBridgeAnswered(bridge.id, reply.id);
    cancelBridgeTask(ctx, bridge.id);
    const questionContent = ctx.db.getGroupMessageContent(bridge.question_msg_id) || "(原问题已删除)";
    const qSnippet = questionContent.slice(0, 200);
    const replySnippet = reply.content.slice(0, 500);
    const msg =
      `@${bridge.asker} [ask-bridge 复述] ${bridge.target} 在 ${reply.created_at} 回复了你之前的提问:\n` +
      `你问: ${qSnippet}\n` +
      `${bridge.target} 回复: ${replySnippet}\n` +
      `\n` +
      `**下一步**:基于这条回复继续你之前的任务。如果你不记得任务上下文(新 session),**立即跑 \`rotom group history ${bridge.group_id} --limit 10\`**,找到你问之前是谁 @ 你的、他们让你做什么,然后把 ${bridge.target} 的回复告诉那个人。`;
    ctx.hub.postSystemToGroup(bridge.group_id, msg);
    log.info(`bridge #${bridge.id} answered by handler: ${bridge.target} replied (msg ${reply.id}), restated to ${bridge.asker}`);
    return { status: "ok" };
  }

  // 2. 超时(5min 到,无回复)→ 创建升级 Issue + disable task
  if (bridge.expires_at < now) {
    const issueId = randomUUID();
    const questionContent = ctx.db.getGroupMessageContent(bridge.question_msg_id) || "(原问题已删除)";
    const qSnippet = questionContent.slice(0, 200);
    const createdIso = new Date(bridge.created_at).toISOString();
    const minutes = Math.max(1, Math.round(bridge.timeout_ms / 60_000));
    const escalateTo = bridge.escalate_to || "(自己挑群里在线的真人)";
    const title = `[ask-bridge] ${bridge.target} 未回复,需升级`;
    const description = [
      `[系统触发:ask-bridge 超时升级]`,
      `你于 ${createdIso} 在群 "${bridge.group_id}" 问 ${bridge.target}:`,
      `  "${qSnippet}"`,
      ``,
      `${minutes} 分钟内 ${bridge.target} 未回复。请去群里 @ ${escalateTo} 求救,说明:`,
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

/** cancel name=`ask-bridge:<bridgeId前8位>` 的 scheduled_task(disable,保留在列表里做审计)。 */
function cancelBridgeTask(ctx: HandlerContext, bridgeId: string): void {
  const taskName = `ask-bridge:${bridgeId.slice(0, 8)}`;
  const task = ctx.db.findScheduledTaskByName(taskName);
  if (task && task.enabled) {
    ctx.db.disableScheduledTask(task.id);
    log.info(`bridge ${bridgeId}: cancelled schedule task "${taskName}" (#${task.id})`);
  }
}
