/**
 * Guidance templates — 群指导 prompt 模板库。
 *
 * 每条模板包含 prompt_text 和可选的 schedule_config(JSON 字符串)。选模板时
 * 前端把 prompt_text 填进 groups.guidance_prompt；若 schedule_config 存在,
 * 同时调 schedules.createScheduledTask 建定时任务。prompt_text 和
 * schedule_config 都支持 {{teacher}}/{{student}}/{{topic}} 占位符,在前端解析。
 *
 * 种子模板 is_default=1,deleteGuidanceTemplate 拒绝删除,API 也兜底返回 400。
 */

import type { MeshDbSelf } from "./core.js";

export interface GuidanceTemplateRow {
  id: number;
  name: string;
  description: string;
  prompt_text: string;
  schedule_config: string | null;
  sort_order: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

export const guidanceTemplateMethods = {
  listGuidanceTemplates(this: MeshDbSelf): GuidanceTemplateRow[] {
    return this.db.prepare(
      "SELECT * FROM guidance_templates ORDER BY sort_order ASC, id ASC",
    ).all() as GuidanceTemplateRow[];
  },

  getGuidanceTemplate(this: MeshDbSelf, id: number): GuidanceTemplateRow | undefined {
    return this.db.prepare("SELECT * FROM guidance_templates WHERE id = ?")
      .get(id) as GuidanceTemplateRow | undefined;
  },

  createGuidanceTemplate(this: MeshDbSelf, input: {
    name: string;
    description?: string;
    prompt_text: string;
    schedule_config?: string | null;
    sort_order?: number;
  }): GuidanceTemplateRow {
    const now = Date.now();
    const info = this.db.prepare(`
      INSERT INTO guidance_templates (
        name, description, prompt_text, schedule_config, sort_order, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.name,
      input.description ?? "",
      input.prompt_text,
      input.schedule_config ?? null,
      input.sort_order ?? 0,
      now,
      now,
    );
    return this.getGuidanceTemplate(Number(info.lastInsertRowid))!;
  },

  updateGuidanceTemplate(this: MeshDbSelf, id: number, patch: {
    name?: string;
    description?: string;
    prompt_text?: string;
    schedule_config?: string | null;
    sort_order?: number;
  }): GuidanceTemplateRow | undefined {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.description !== undefined) { sets.push("description = ?"); params.push(patch.description); }
    if (patch.prompt_text !== undefined) { sets.push("prompt_text = ?"); params.push(patch.prompt_text); }
    if (patch.schedule_config !== undefined) { sets.push("schedule_config = ?"); params.push(patch.schedule_config); }
    if (patch.sort_order !== undefined) { sets.push("sort_order = ?"); params.push(patch.sort_order); }
    if (sets.length === 0) return this.getGuidanceTemplate(id);
    sets.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);
    this.db.prepare(`UPDATE guidance_templates SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getGuidanceTemplate(id);
  },

  /** 删除模板;种子模板(is_default=1)拒绝删除,返回 false。 */
  deleteGuidanceTemplate(this: MeshDbSelf, id: number): boolean {
    const row = this.getGuidanceTemplate(id);
    if (!row) return false;
    if (row.is_default === 1) return false;
    this.db.prepare("DELETE FROM guidance_templates WHERE id = ?").run(id);
    return true;
  },
};
