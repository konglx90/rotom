/**
 * Schedule patterns — 调度模式参考库。
 *
 * 常见定时任务模式的样板,供用户在配置群指导模板时学习引用。不直接
 * 管理 scheduled_tasks 实例。schedule_config 是 JSON 字符串,形如
 * GuidanceScheduleConfig。
 *
 * 种子模式 is_default=1,deleteSchedulePattern 拒绝删除,API 也兜底返回 400。
 */

import type { MeshDbSelf } from "./core.js";

export interface SchedulePatternRow {
  id: number;
  name: string;
  description: string;
  schedule_config: string | null;
  sort_order: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export const schedulePatternMethods = {
  listSchedulePatterns(this: MeshDbSelf): SchedulePatternRow[] {
    return this.db.prepare(
      "SELECT * FROM schedule_patterns ORDER BY sort_order ASC, id ASC",
    ).all() as SchedulePatternRow[];
  },

  getSchedulePattern(this: MeshDbSelf, id: number): SchedulePatternRow | undefined {
    return this.db.prepare("SELECT * FROM schedule_patterns WHERE id = ?")
      .get(id) as SchedulePatternRow | undefined;
  },

  createSchedulePattern(this: MeshDbSelf, input: {
    name: string;
    description?: string;
    schedule_config?: string | null;
    sort_order?: number;
  }): SchedulePatternRow {
    const now = Date.now();
    const info = this.db.prepare(`
      INSERT INTO schedule_patterns (
        name, description, schedule_config, sort_order, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.name,
      input.description ?? "",
      input.schedule_config ?? null,
      input.sort_order ?? 0,
      now,
      now,
    );
    return this.getSchedulePattern(Number(info.lastInsertRowid))!;
  },

  updateSchedulePattern(this: MeshDbSelf, id: number, patch: {
    name?: string;
    description?: string;
    schedule_config?: string | null;
    sort_order?: number;
  }): SchedulePatternRow | undefined {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
    if (patch.schedule_config !== undefined) { sets.push("schedule_config = ?"); params.push(patch.schedule_config); }
    if (patch.sort_order !== undefined) { sets.push("sort_order = ?"); params.push(patch.sort_order); }
    if (sets.length === 0) return this.getSchedulePattern(id);
    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    this.db.prepare(`UPDATE schedule_patterns SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getSchedulePattern(id);
  },

  /** 删除模式;种子模式(is_default=1)拒绝删除,返回 false。 */
  deleteSchedulePattern(this: MeshDbSelf, id: number): boolean {
    const row = this.getSchedulePattern(id);
    if (!row) return false;
    if (row.is_default === 1) return false;
    this.db.prepare("DELETE FROM schedule_patterns WHERE id = ?").run(id);
    return true;
  },
};
