import { toBeijing } from "../shared/time.js";
/**
 * Scheduler — 群内定时任务调度器
 *
 * 设计要点(参考 hermes-agent cron/scheduler.py + cron/jobs.py,简化后落到 rotom):
 *
 *  - `next_run_at` 字段驱动:不靠 `last_run_at + interval` 算,而是显式维护下次运行时间。
 *  - schedule 两形态:
 *      - schedule_kind='interval' + interval_sec: 每 N 秒跑一次
 *      - schedule_kind='once' + run_at: 在指定时间戳跑一次,跑完自动 enabled=0
 *  - grace window 防宕机堆积:Master 宕机后重启,如果 now - next_run_at > grace 就
 *    fast-forward 到下一个未来时间点,不补跑历史。recurring 用 `computeGraceSec`
 *    (max(120, min(interval_sec/2, 7200)));一次性任务用 ONESHOT_GRACE_SEC=120。
 *  - at-most-once:执行前先把 next_run_at 推进到下一个时间点,再派 Issue / 发消息,
 *    崩溃后重启不会重跑。
 *  - 两种触发模式:
 *      - mode='agent': 创建 Issue + hub.pushIssueAssignment(group_id, agent_name),
 *        agent 离线或上一轮 Issue 仍 in_progress 就跳过,但 next_run_at 仍推进。
 *      - mode='message': 直接调 hub.postSystemToGroup(group_id, prompt),无需 agent。
 *  - 串行 tick:20s 一次(TICK_MS),无需并行池;Issue 在 worker 进程跑,不阻塞 scheduler。
 *
 * 不在本期:
 *  - tryClaimNextIssue 的 poller(plan 已选 push 路径)
 *  - Dashboard UI / WS 协议变更 / 跨 Master 协调 / cron 表达式 / file lock
 */

import { randomUUID } from "node:crypto";
import type { MeshDb, ScheduledTaskRow } from "./db.js";
import { resolveGroupAgentWorkingDir } from "./group-paths.js";
import { createLogger } from "../shared/logger.js";
import { getSchedulerHandler } from "./scheduler-handlers.js";

const log = createLogger("mesh-scheduler");

/** 调度器扫描周期。每 20s 看一眼:扫 scheduled_tasks(含 ask-bridge handler)。 */
const TICK_MS = 20_000;

/** 一次性任务的 grace window,固定 120s。 */
const ONESHOT_GRACE_SEC = 120;

/** recurring 任务 grace 下界 / 上界。 */
const MIN_GRACE_SEC = 120;
const MAX_GRACE_SEC = 7200;

function computeGraceSec(intervalSec: number): number {
  return Math.max(MIN_GRACE_SEC, Math.min(Math.floor(intervalSec / 2), MAX_GRACE_SEC));
}

// 调度器依赖的 hub 能力子集,只声明会用到的,避免循环依赖 ws-hub。
export interface SchedulerHub {
  postSystemToGroup(groupId: string, content: string): void;
  pushIssueAssignment(issueId: string, agentName: string): boolean;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private db: MeshDb, private hub: SchedulerHub) {}

  start(): void {
    if (this.timer) return;
    log.info(`Scheduler started (tick=${TICK_MS}ms)`);
    this.timer = setInterval(
      () => this.tick().catch((err) => log.error("scheduler tick failed", err)),
      TICK_MS,
    );
    // 启动时立刻扫一次,避免冷启动后等满 30s
    this.tick().catch((err) => log.error("scheduler initial tick failed", err));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Scheduler stopped");
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // 上一轮还没跑完,跳过(避免 tick 重叠)
    this.ticking = true;
    try {
      const now = Date.now();
      const due = this.db.getDueScheduledTasks(now);
      if (due.length === 0) return;
      log.info(`tick: ${due.length} task(s) due`);
      for (const task of due) {
        await this.runOne(task, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(task: ScheduledTaskRow, now: number): Promise<void> {
    // 1. 宕机堆积保护:recurring 任务错过超过 grace 窗口,fast-forward 不补跑
    if (task.schedule_kind === "interval") {
      const graceSec = computeGraceSec(task.interval_sec!);
      if (now - task.next_run_at > graceSec * 1000) {
        const next = now + task.interval_sec! * 1000;
        this.db.rescheduleTask(task.id, next);
        log.info(
          `task #${task.id} "${task.name}" stale, fast-forward to ${toBeijing(next)}`,
        );
        return;
      }
    } else if (task.schedule_kind === "once") {
      // 一次性任务用更小的 grace;过了太久没跑就当过期,直接 disable
      if (now - task.next_run_at > ONESHOT_GRACE_SEC * 1000) {
        this.db.disableScheduledTask(task.id);
        log.info(`task #${task.id} "${task.name}" oneshot expired, disabled`);
        return;
      }
    }

    // 2. at-most-once:先把 next_run_at 推进,再执行。崩溃后重启不会重跑
    const nextRun = this.computeNextRun(task, now);
    if (nextRun !== null) {
      this.db.rescheduleTask(task.id, nextRun);
    }
    const newRepeatCount = task.repeat_count + 1;

    try {
      // handler 模式:跑硬编码逻辑(ask-bridge-check 等),不走 prompt/agent 路径
      if (task.handler_key) {
        const handler = getSchedulerHandler(task.handler_key);
        if (!handler) {
          this.db.markScheduledTaskRun(task.id, now, "error", `unknown handler: ${task.handler_key}`, null, newRepeatCount);
          log.error(`task #${task.id} "${task.name}" unknown handler: ${task.handler_key}`);
          this.autoDisableIfDone(task, newRepeatCount);
          return;
        }
        let payload: unknown;
        try {
          payload = task.handler_payload ? JSON.parse(task.handler_payload) : {};
        } catch (e: any) {
          this.db.markScheduledTaskRun(task.id, now, "error", `bad handler_payload JSON: ${e.message}`, null, newRepeatCount);
          log.error(`task #${task.id} "${task.name}" bad handler_payload`, e);
          this.autoDisableIfDone(task, newRepeatCount);
          return;
        }
        const result = await handler(payload, { db: this.db, hub: this.hub });
        this.db.markScheduledTaskRun(task.id, now, result.status, result.error ?? null, result.issueId ?? null, newRepeatCount);
        log.info(`task #${task.id} "${task.name}" handler "${task.handler_key}" → ${result.status}${result.issueId ? ` (issue ${result.issueId})` : ""}`);
        this.autoDisableIfDone(task, newRepeatCount);
        return;
      }

      if (task.mode === "message") {
        this.hub.postSystemToGroup(task.group_id, task.prompt);
        this.db.markScheduledTaskRun(task.id, now, "ok", null, null, newRepeatCount);
        log.info(`task #${task.id} "${task.name}" message posted to group ${task.group_id}`);
      } else {
        // agent 模式:防堆积,上一轮 Issue 仍 in_progress 就跳过(但 next_run_at 已推进)
        if (task.last_issue_id) {
          const prev = this.db.getIssueById(task.last_issue_id);
          if (prev && prev.status === "in_progress") {
            this.db.markScheduledTaskRun(task.id, now, "skipped", "prev issue in_progress", null, newRepeatCount);
            log.info(`task #${task.id} "${task.name}" skipped: prev issue still in_progress`);
            this.autoDisableIfDone(task, newRepeatCount);
            return;
          }
        }
        const agent = this.db.getAgentByName(task.agent_name!);
        if (!agent || agent.status !== "online") {
          const reason = !agent ? "agent not found" : "agent offline";
          this.db.markScheduledTaskRun(task.id, now, "skipped", reason, null, newRepeatCount);
          log.info(`task #${task.id} "${task.name}" skipped: ${reason}`);
          this.autoDisableIfDone(task, newRepeatCount);
          return;
        }

        const issueId = randomUUID();
        this.db.createIssue({
          id: issueId,
          groupId: task.group_id,
          title: `[定时] ${task.name}`,
          description: task.prompt,
          createdBy: "system:scheduler",
          workingDir: resolveGroupAgentWorkingDir(this.db, task.group_id, task.agent_name!),
          assignedTo: task.agent_name!,
        });
        const pushed = this.hub.pushIssueAssignment(issueId, task.agent_name!);
        if (!pushed) {
          this.db.markScheduledTaskRun(task.id, now, "error", "pushIssueAssignment failed", null, newRepeatCount);
          log.warn(`task #${task.id} "${task.name}" push failed`);
          this.autoDisableIfDone(task, newRepeatCount);
          return;
        }
        this.db.markScheduledTaskRun(task.id, now, "ok", null, issueId, newRepeatCount);
        log.info(`task #${task.id} "${task.name}" dispatched issue ${issueId} → ${task.agent_name}`);
      }

      this.autoDisableIfDone(task, newRepeatCount);
    } catch (err: any) {
      this.db.markScheduledTaskRun(task.id, now, "error", String(err?.message ?? err), null, newRepeatCount);
      log.error(`task #${task.id} "${task.name}" threw`, err);
      this.autoDisableIfDone(task, newRepeatCount);
    }
  }

  /** 一次性任务或 repeat_times 用尽,自动 enabled=0。 */
  private autoDisableIfDone(task: ScheduledTaskRow, newCount: number): void {
    if (task.schedule_kind === "once") {
      this.db.disableScheduledTask(task.id);
    } else if (task.repeat_times != null && newCount >= task.repeat_times) {
      this.db.disableScheduledTask(task.id);
      log.info(`task #${task.id} "${task.name}" reached repeat_times=${task.repeat_times}, disabled`);
    }
  }

  private computeNextRun(task: ScheduledTaskRow, now: number): number | null {
    if (task.schedule_kind === "once") return null; // 一次性跑完靠 disable 兜底
    return now + task.interval_sec! * 1000;
  }
}
