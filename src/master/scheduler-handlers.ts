import { nowBeijing, toBeijing } from "../shared/time.js";
import { extractMentions } from "../shared/mention.js";
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
 */

import { generateShortId } from "../shared/short-id.js";
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
    const replyMentions = extractMentions(reply.content);
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
    // sync 模式不升级 Issue——CLI 端阻塞轮询自己处理超时,只标记 timed_out + disable task
    if (bridge.mode === "sync") {
      ctx.db.markBridgeTimedOut(bridge.id, null, null);
      cancelBridgeTask(ctx, bridge.id);
      log.info(`bridge #${bridge.id} timed_out (sync mode, no escalation)`);
      return { status: "ok" };
    }
    const issueId = generateShortId();
    const questionContent = ctx.db.getGroupMessageContent(bridge.question_msg_id) || "(原问题已删除)";
    const qSnippet = questionContent.slice(0, 200);
    const createdIso = toBeijing(bridge.created_at);
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

// ── issue-patrol handler ────────────────────────────────────────────────────

/**
 * Issue 巡检 —— 主动出击 Phase 1。
 *
 * 每小时跑一次(interval 任务),挂在 patrol 群的 scheduled_tasks 行上。
 * task.group_id / task.agent_name 即巡检群 / 巡检员。
 * handler_payload: { patrolGroupId, patrolAgentName, throughputCap=3, candidateCap=3, scanBatch=10 }
 *
 * 流程(详见计划 atomic-beaming-hammock.md):
 *   1. 防 overlap:上轮 patrol issue 仍 in_progress → skipped_overlap
 *   2. 巡检员不在线 → agent_offline
 *   3. 全局 in_progress ≥ throughputCap → skipped_quota
 *   4. 取 open 候选(排除自己),按 priority 排,前 scanBatch 条
 *   5. 组装 patrol issue(候选列表 + 规则 skill 全文 + 输出指令)
 *   6. createIssue + pushIssueAssignment + createPatrolRun
 *   7. fire-and-forget:巡检员完成后由 _onIssueTerminal hook 解析 result 落库
 *
 * Phase 1 不分配任何候选 issue,只产日志。
 */
interface IssuePatrolPayload {
  patrolGroupId?: string;
  patrolAgentName?: string;
  throughputCap?: number;
  candidateCap?: number;
  scanBatch?: number;
}

const PATROL_PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function patrolPriorityRank(p: string): number {
  return PATROL_PRIORITY_ORDER[p] ?? 99;
}

registerSchedulerHandler("issue-patrol", async (payload, ctx) => {
  const p = (payload ?? {}) as IssuePatrolPayload;
  const throughputCap = p.throughputCap ?? 3;
  const candidateCap = p.candidateCap ?? 3;
  const scanBatch = p.scanBatch ?? 10;

  // task.group_id / task.agent_name 本应是 patrolGroupId / patrolAgentName,
  // 但 HandlerContext 只暴露 db/hub,scheduler.runOne 没把 task 传进来。
  // 所以 patrolGroupId/patrolAgentName 在 handler_payload 里显式携带
  // (由 POST /api/groups 建 patrol 群时写入,PATCH /api/issues-patrol/config 可改)。
  const { patrolGroupId, patrolAgentName } = p;
  if (!patrolGroupId || !patrolAgentName) {
    return { status: "error", error: "missing patrolGroupId/patrolAgentName in handler_payload" };
  }

  const runId = generateShortId();
  const startedAt = nowBeijing();

  // 1. 防 overlap:查该 patrol 群最近一次 run,若 patrol_issue 仍 in_progress 则跳过
  const recentRuns = ctx.db.listPatrolRuns({ patrolGroupId, limit: 1 });
  const lastRun = recentRuns[0];
  if (lastRun && lastRun.patrol_issue_id && lastRun.status === "dispatched") {
    const prevIssue = ctx.db.getIssueById(lastRun.patrol_issue_id);
    if (prevIssue && prevIssue.status === "in_progress") {
      ctx.db.createPatrolRun({
        runId,
        patrolGroupId,
        startedAt,
        inProgressCount: 0,
        status: "skipped_overlap",
      });
      ctx.db.finishPatrolRun(runId, "skipped_overlap", { note: `prev patrol issue ${prevIssue.id} still in_progress` });
      log.info(`patrol run ${runId}: skipped_overlap (prev ${prevIssue.id})`);
      return { status: "skipped", error: "prev patrol issue in_progress" };
    }
  }

  // 2. 巡检员在线检查
  const agent = ctx.db.getAgentByName(patrolAgentName);
  if (!agent || agent.status !== "online") {
    ctx.db.createPatrolRun({
      runId,
      patrolGroupId,
      startedAt,
      inProgressCount: 0,
      status: "agent_offline",
    });
    ctx.db.finishPatrolRun(runId, "agent_offline", { note: !agent ? "agent not found" : "agent offline" });
    log.info(`patrol run ${runId}: agent_offline (${patrolAgentName})`);
    return { status: "skipped", error: "patrol agent offline" };
  }

  // 3. 全局 in_progress 计数(排除 patrol 群自己)
  const inProgress = ctx.db.listAllIssues("in_progress").filter((i) => i.group_id !== patrolGroupId);
  const inProgressCount = inProgress.length;
  if (inProgressCount >= throughputCap) {
    ctx.db.createPatrolRun({
      runId,
      patrolGroupId,
      startedAt,
      inProgressCount,
      status: "skipped_quota",
    });
    ctx.db.finishPatrolRun(runId, "skipped_quota", { note: `throughput cap reached (${inProgressCount}/${throughputCap})` });
    log.info(`patrol run ${runId}: skipped_quota (in_progress=${inProgressCount})`);
    return { status: "ok" };
  }

  // 4. 取候选 open issue(排除 patrol 群自己),按 priority 排
  const slots = candidateCap - inProgressCount;
  if (slots <= 0) {
    ctx.db.createPatrolRun({
      runId,
      patrolGroupId,
      startedAt,
      inProgressCount,
      status: "skipped_quota",
    });
    ctx.db.finishPatrolRun(runId, "skipped_quota", { note: `no slots (in_progress=${inProgressCount}, cap=${candidateCap})` });
    log.info(`patrol run ${runId}: skipped_quota (no slots)`);
    return { status: "ok" };
  }

  // 候选数量:既要喂饱巡检员找满 slots 个 ready,又不能扫太多浪费 token。
  // 取 max(slots, scanBatch/2) 上限 scanBatch。
  const take = Math.min(scanBatch, Math.max(slots, Math.ceil(scanBatch / 2)));
  const openIssues = ctx.db.listAllIssues("open")
    .filter((i) => i.group_id !== patrolGroupId && i.type === "task")
    .sort((a, b) => {
      const rankDiff = patrolPriorityRank(a.priority) - patrolPriorityRank(b.priority);
      if (rankDiff !== 0) return rankDiff;
      return a.created_at < b.created_at ? -1 : 1;
    })
    .slice(0, take);

  if (openIssues.length === 0) {
    ctx.db.createPatrolRun({
      runId,
      patrolGroupId,
      startedAt,
      inProgressCount,
      status: "completed",
    });
    ctx.db.finishPatrolRun(runId, "completed", { scanned: 0, ready: 0, note: "no open candidates" });
    log.info(`patrol run ${runId}: no open candidates`);
    return { status: "ok" };
  }

  // 5. 取规则 skill 全文
  const skill = ctx.db.getSkillByName("issue-patrol-rules");
  const rulesText = skill?.content ?? "(rules skill not found;fall back to default judgment)";

  // 6. 组装 patrol issue
  const candidateList = openIssues.map((iss, idx) => {
    return [
      `### 候选 ${idx + 1}: ${iss.title}`,
      `- issue_id: ${iss.id}`,
      `- group_id: ${iss.group_id}`,
      `- priority: ${iss.priority}`,
      `- slash_command: ${iss.slash_command ?? "(无)"}`,
      `- working_dir: ${iss.working_dir ?? "(默认)"}`,
      `- created_at: ${iss.created_at}`,
      `- description:`,
      iss.description?.slice(0, 800) ?? "(空)",
    ].join("\n");
  }).join("\n\n");

  const title = `[巡检] ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  const description = [
    `# Issue 巡检任务`,
    ``,
    `你是巡检员。本轮全局 in_progress=${inProgressCount}(cap ${throughputCap}),剩余 slot=${slots}。`,
    `下面是 ${openIssues.length} 个候选 open issue,请逐个判断"是否可以直接认领开工"。`,
    ``,
    `## 巡检规则`,
    ``,
    rulesText,
    ``,
    `## 候选列表`,
    ``,
    candidateList,
    ``,
    `## 输出要求`,
    ``,
    `**不要**认领、分配、或操作任何候选 issue。只输出判断。`,
    `result 字段必须是 JSON 数组,每条:`,
    "```json",
    `{`,
    `  "issue_id": "<候选 id>",`,
    `  "verdict": "ready" | "not_ready" | "uncertain",`,
    `  "rule_matched": "<命中的规则名>",`,
    `  "rationale": "<一句话理由>"`,
    `}`,
    "```",
    `找满 ${slots} 个 ready 就可以停(不要继续往后扫)。`,
  ].join("\n");

  // 7. 派 issue + 写 run
  const issueId = generateShortId();
  ctx.db.createIssue({
    id: issueId,
    groupId: patrolGroupId,
    title,
    description,
    priority: "medium",
    createdBy: "system:issue-patrol",
    workingDir: resolveGroupAgentWorkingDir(ctx.db, patrolGroupId, patrolAgentName),
    assignedTo: patrolAgentName,
  });

  ctx.db.createPatrolRun({
    runId,
    patrolGroupId,
    patrolIssueId: issueId,
    startedAt,
    inProgressCount,
    status: "dispatched",
  });

  const pushed = ctx.hub.pushIssueAssignment(issueId, patrolAgentName);
  if (!pushed) {
    ctx.db.finishPatrolRun(runId, "error", { note: "pushIssueAssignment failed" });
    log.warn(`patrol run ${runId}: pushIssueAssignment to ${patrolAgentName} failed`);
    return { status: "error", error: "pushIssueAssignment failed", issueId };
  }

  log.info(`patrol run ${runId}: dispatched issue ${issueId} → ${patrolAgentName} (${openIssues.length} candidates, slots=${slots})`);
  return { status: "ok", issueId };
});

// ── link-patrol handler ────────────────────────────────────────────────────

/**
 * 链接智能分类 —— 每小时跑一次,挂在 patrol-link 群的 scheduled_tasks 行上。
 * task.group_id / task.agent_name 即链接分类巡检群 / 巡检员。
 * handler_payload: { patrolGroupId, patrolAgentName, scanBatch=20 }
 *
 * 流程:
 *   1. 防 overlap:上轮 link-patrol issue 仍 in_progress → skipped_overlap
 *   2. 巡检员不在线 → agent_offline
 *   3. 取 scanBatch 条未分类链接(category IS NULL,按 last_seen_at desc)
 *   4. 无候选 → completed (scanned=0)
 *   5. 拉 memory few-shot(tags=link_classification)+ skill 规则全文,拼 description
 *   6. createIssue + createLinkPatrolRun(patrol_issue_id=issueId) + pushIssueAssignment
 *   7. fire-and-forget:巡检员完成后由 server.ts 的 _onIssueTerminal hook 分流到
 *      handleLinkPatrolIssueTerminal 解析 result 落库(UPDATE links + 写 logs + memory)
 */
interface LinkPatrolPayload {
  patrolGroupId?: string;
  patrolAgentName?: string;
  scanBatch?: number;
}

registerSchedulerHandler("link-patrol", async (payload, ctx) => {
  const p = (payload ?? {}) as LinkPatrolPayload;
  const scanBatch = p.scanBatch ?? 20;

  const { patrolGroupId, patrolAgentName } = p;
  if (!patrolGroupId || !patrolAgentName) {
    return { status: "error", error: "missing patrolGroupId/patrolAgentName in handler_payload" };
  }

  const runId = generateShortId();
  const startedAt = nowBeijing();

  // 1. 防 overlap:查该 patrol-link 群最近一次 run,patrol_issue 仍 in_progress 跳过
  const recentRuns = ctx.db.listLinkPatrolRuns({ patrolGroupId, limit: 1 });
  const lastRun = recentRuns[0];
  if (lastRun && lastRun.patrol_issue_id && lastRun.status === "dispatched") {
    const prevIssue = ctx.db.getIssueById(lastRun.patrol_issue_id);
    if (prevIssue && prevIssue.status === "in_progress") {
      ctx.db.createLinkPatrolRun({
        runId,
        patrolGroupId,
        startedAt,
        status: "skipped",
      });
      ctx.db.finishLinkPatrolRun(runId, "skipped", { note: `prev patrol issue ${prevIssue.id} still in_progress` });
      log.info(`link-patrol run ${runId}: skipped_overlap (prev ${prevIssue.id})`);
      return { status: "skipped", error: "prev link-patrol issue in_progress" };
    }
  }

  // 2. 巡检员在线检查
  const agent = ctx.db.getAgentByName(patrolAgentName);
  if (!agent || agent.status !== "online") {
    ctx.db.createLinkPatrolRun({
      runId,
      patrolGroupId,
      startedAt,
      status: "agent_offline",
    });
    ctx.db.finishLinkPatrolRun(runId, "agent_offline", { note: !agent ? "agent not found" : "agent offline" });
    log.info(`link-patrol run ${runId}: agent_offline (${patrolAgentName})`);
    return { status: "skipped", error: "link-patrol agent offline" };
  }

  // 3. 取候选未分类链接
  const candidates = ctx.db.listUnclassifiedLinks(scanBatch);
  if (candidates.length === 0) {
    ctx.db.createLinkPatrolRun({
      runId,
      patrolGroupId,
      startedAt,
      status: "completed",
    });
    ctx.db.finishLinkPatrolRun(runId, "completed", { classified: 0, note: "no unclassified links" });
    log.info(`link-patrol run ${runId}: no unclassified links`);
    return { status: "ok" };
  }

  // 4. 拉 memory few-shot:agent_visible=1 + tags 含 link_classification,scope=global
  const rules = ctx.db.listMemory({
    scope: "global",
    tags: ["link_classification"],
    agentVisible: 1,
    limit: 20,
  });

  // 5. 拉 skill 全文
  const skill = ctx.db.getSkillByName("link-patrol-rules");
  const rulesText = skill?.content ?? "(link-patrol-rules skill not found; fall back to default categories)";

  // 6. 拼 description
  const candidateList = candidates.map((l, idx) => {
    return [
      `### 候选 ${idx + 1}: ${l.host}`,
      `- link_id: ${l.id}`,
      `- url_raw: ${l.url_raw}`,
      `- 首次上下文: ${l.first_context || "(无)"}`,
      `- 最后见到: ${l.last_seen_at}`,
    ].join("\n");
  }).join("\n\n");

  const fewShotBlock = rules.length > 0
    ? [
        "## 历史分类经验(few-shot,memory 自动积累)",
        "复用这些规则;若 host 在下列出现过,优先沿用旧分类:",
        ...rules.map((r) => `- ${r.key}: ${r.summary ?? "(无 summary)"}`),
      ].join("\n")
    : "(暂无历史经验,这是首轮)";

  const title = `[链接分类] ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  const description = [
    "# 链接分类任务",
    ``,
    `本轮有 ${candidates.length} 条待分类链接。按规则给出 category + tags + title + rationale。`,
    ``,
    "## 分类规则",
    "",
    rulesText,
    "",
    fewShotBlock,
    "",
    "## 候选链接",
    "",
    candidateList,
    "",
    "## 输出要求",
    "",
    "issue `result` 字段必须是 JSON 数组,用 markdown ```json 代码块包裹,每条:",
    "```json",
    "{",
    '  "link_id": "<uuid>",',
    '  "category": "reference | code | tool | article | paper | discussion | issue-tracker | media | other",',
    '  "tags": ["keyword1", "keyword2"],',
    '  "title": "<人类可读标题>",',
    '  "rationale": "<一句话: host + path 模式 → category 推断理由>"',
    "}",
    "```",
  ].join("\n");

  // 7. 派 issue
  const issueId = generateShortId();
  ctx.db.createIssue({
    id: issueId,
    groupId: patrolGroupId,
    title,
    description,
    priority: "medium",
    createdBy: "system:link-patrol",
    workingDir: resolveGroupAgentWorkingDir(ctx.db, patrolGroupId, patrolAgentName),
    assignedTo: patrolAgentName,
  });

  ctx.db.createLinkPatrolRun({
    runId,
    patrolGroupId,
    patrolIssueId: issueId,
    startedAt,
    candidatesScanned: candidates.length,
    status: "dispatched",
  });

  const pushed = ctx.hub.pushIssueAssignment(issueId, patrolAgentName);
  if (!pushed) {
    ctx.db.finishLinkPatrolRun(runId, "error", { note: "pushIssueAssignment failed" });
    log.warn(`link-patrol run ${runId}: pushIssueAssignment to ${patrolAgentName} failed`);
    return { status: "error", error: "pushIssueAssignment failed", issueId };
  }

  log.info(`link-patrol run ${runId}: dispatched issue ${issueId} → ${patrolAgentName} (${candidates.length} candidates)`);
  return { status: "ok", issueId };
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

// ── a2a-direct-ttl-sweep handler ────────────────────────────────────────────

/**
 * a2a_direct pair 群 TTL 清扫。每小时跑一次。
 *
 * `rotom ask` 触发的 pair 群 last_activity_at 3 天无活动 → archive。
 * 普通群(chat)、巡检群(patrol/patrol-link)不扫。
 */
registerSchedulerHandler("a2a-direct-ttl-sweep", async (_payload, ctx) => {
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const stale = ctx.db.listStalePairGroups(cutoff);
  let archived = 0;
  for (const g of stale) {
    ctx.db.archiveGroup(g.id);
    archived++;
    log.info(`a2a-direct TTL sweep: archived group ${g.id} "${g.name}" (inactive since ${toBeijing(g.last_activity_at ?? 0)})`);
  }
  if (archived > 0) {
    log.info(`a2a-direct TTL sweep: ${archived} group(s) archived (cutoff=${toBeijing(cutoff)})`);
  }
  return { status: "ok", archived };
});
