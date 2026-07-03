/**
 * Scheduled tasks — at-most-once cron-style triggers with run history.
 *
 * Methods attach via `Object.assign`. The scheduler module (./scheduler.ts)
 * pulls `getDueScheduledTasks` each tick and calls `markScheduledTaskRun`
 * after the run completes. `next_run_at` is the integer-ms epoch field the
 * scheduler indexes on; `markScheduledTaskRun` preserves `last_issue_id`
 * when `issueId=null` is passed so the agent mode can re-bind to the same
 * issue across repeat iterations.
 */

import type { ScheduledTaskRow } from "./types.js";
import { buildUpdate } from "./build-update.js";
import type { MeshDbSelf } from "./core.js";

export const scheduleMethods = {
  listScheduledTasks(this: MeshDbSelf, filter?: { groupId?: string }): ScheduledTaskRow[] {
    let sql = "SELECT * FROM scheduled_tasks WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.groupId) {
      sql += " AND group_id = ?";
      params.push(filter.groupId);
    }
    sql += " ORDER BY id DESC";
    return this.db.prepare(sql).all(...params) as ScheduledTaskRow[];
  },

  getScheduledTask(this: MeshDbSelf, id: number): ScheduledTaskRow | undefined {
    return this.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?")
      .get(id) as ScheduledTaskRow | undefined;
  },

  /** 返回所有已启用、且 next_run_at <= now 的任务。调度器串行消费。 */
  getDueScheduledTasks(this: MeshDbSelf, now: number): ScheduledTaskRow[] {
    return this.db.prepare(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
    ).all(now) as ScheduledTaskRow[];
  },

  /** 新建任务;返回插入后的完整 row(包含自动算出的首个 next_run_at)。 */
  createScheduledTask(this: MeshDbSelf, input: {
    name: string;
    groupId: string;
    mode: "agent" | "message";
    agentName?: string | null;
    scheduleKind: "once" | "interval";
    intervalSec?: number | null;
    runAt?: number | null;
    prompt: string;
    repeatTimes?: number | null;
    enabled?: boolean;
    /** 非空时,task 到点跑 handler_key 对应的硬编码逻辑(而非 prompt/agent)。 */
    handlerKey?: string | null;
    /** JSON 字符串,handler 自行解析。 */
    handlerPayload?: string | null;
  }): ScheduledTaskRow {
    const now = Date.now();
    const enabled = input.enabled === false ? 0 : 1;
    const nextRunAt = input.scheduleKind === "once"
      ? (input.runAt ?? now)
      : now + (input.intervalSec ?? 0) * 1000;
    const info = this.db.prepare(`
      INSERT INTO scheduled_tasks (
        name, group_id, mode, agent_name, schedule_kind, interval_sec, run_at,
        prompt, enabled, next_run_at, repeat_times, repeat_count, created_at, updated_at,
        handler_key, handler_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      input.name,
      input.groupId,
      input.mode,
      input.agentName ?? null,
      input.scheduleKind,
      input.intervalSec ?? null,
      input.runAt ?? null,
      input.prompt,
      enabled,
      nextRunAt,
      input.repeatTimes ?? null,
      now,
      now,
      input.handlerKey ?? null,
      input.handlerPayload ?? null,
    );
    return this.getScheduledTask(Number(info.lastInsertRowid))!;
  },

  /** 部分更新;改 schedule 字段会触发 next_run_at 重算。 */
  updateScheduledTask(this: MeshDbSelf, id: number, patch: {
    name?: string;
    mode?: "agent" | "message";
    agentName?: string | null;
    scheduleKind?: "once" | "interval";
    intervalSec?: number | null;
    runAt?: number | null;
    prompt?: string;
    enabled?: boolean;
    repeatTimes?: number | null;
    handlerKey?: string | null;
    handlerPayload?: string | null;
  }): ScheduledTaskRow | undefined {
    const task = this.getScheduledTask(id);
    if (!task) return undefined;

    // schedule_kind / interval_sec / run_at 任一变化都重算 next_run_at
    const scheduleChanged =
      patch.scheduleKind !== undefined ||
      patch.intervalSec !== undefined ||
      patch.runAt !== undefined;
    const extraSets: Array<{ sql: string; params?: unknown[] } | { column: string; value: unknown }> = [];
    if (scheduleChanged) {
      const kind = patch.scheduleKind ?? task.schedule_kind;
      const intervalSec = patch.intervalSec !== undefined ? patch.intervalSec : task.interval_sec;
      const runAt = patch.runAt !== undefined ? patch.runAt : task.run_at;
      const now = Date.now();
      const nextRunAt = kind === "once"
        ? (runAt ?? now)
        : now + (intervalSec ?? 0) * 1000;
      extraSets.push(
        { column: "schedule_kind", value: kind },
        { column: "interval_sec", value: intervalSec },
        { column: "run_at", value: runAt },
        { column: "next_run_at", value: nextRunAt },
      );
    }

    const built = buildUpdate({
      table: "scheduled_tasks",
      sets: {
        name: patch.name,
        mode: patch.mode,
        agent_name: patch.agentName,
        prompt: patch.prompt,
        enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : undefined,
        repeat_times: patch.repeatTimes,
        handler_key: patch.handlerKey,
        handler_payload: patch.handlerPayload,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "epoch",
      extraSets,
    });
    if (!built) return task;
    this.db.prepare(built.sql).run(...built.params);
    return this.getScheduledTask(id);
  },

  deleteScheduledTask(this: MeshDbSelf, id: number): boolean {
    const result = this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    return result.changes > 0;
  },

  /** at-most-once 推进:先把 next_run_at 推到下一个未来时间点,再执行。 */
  rescheduleTask(this: MeshDbSelf, id: number, nextRunAt: number): void {
    this.db.prepare(
      "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?",
    ).run(nextRunAt, Date.now(), id);
  },

  /** 立刻触发:把 next_run_at 设为 now,下一个 tick 就跑。 */
  triggerScheduledTask(this: MeshDbSelf, id: number, now: number = Date.now()): boolean {
    const result = this.db.prepare(
      "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1",
    ).run(now, Date.now(), id);
    return result.changes > 0;
  },

  /** 记录本次执行结果。repeat_count 由调度器计算后传入,这里直接覆写。
   *  issueId=null 保留上一次 last_issue_id（用于 agent skip 的防堆积场景 —— 下一轮继续反查同一个 prev issue）;
   *  传字符串才覆写。
   *  没有显式 clear 路径 —— last_issue_id 一旦被 agent 模式写入就持续追踪到 disable 为止。 */
  markScheduledTaskRun(
    this: MeshDbSelf,
    id: number,
    runAt: number,
    status: "ok" | "error" | "skipped",
    error: string | null,
    issueId: string | null,
    repeatCount: number,
  ): void {
    if (issueId !== null) {
      this.db.prepare(`
        UPDATE scheduled_tasks SET
          last_run_at = ?,
          last_status = ?,
          last_error = ?,
          last_issue_id = ?,
          repeat_count = ?,
          updated_at = ?
        WHERE id = ?
      `).run(runAt, status, error, issueId, repeatCount, Date.now(), id);
    } else {
      this.db.prepare(`
        UPDATE scheduled_tasks SET
          last_run_at = ?,
          last_status = ?,
          last_error = ?,
          repeat_count = ?,
          updated_at = ?
        WHERE id = ?
      `).run(runAt, status, error, repeatCount, Date.now(), id);
    }
  },

  /** 一次性任务跑完,或 repeat_times 用尽,自动 enabled=0。 */
  disableScheduledTask(this: MeshDbSelf, id: number): void {
    this.db.prepare(
      "UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?",
    ).run(Date.now(), id);
  },
};