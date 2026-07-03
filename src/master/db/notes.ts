import { nowBeijing } from "../../shared/time.js";
import { buildUpdate } from "./build-update.js";
/**
 * Notes — 兼容层。notes 表已升级为 agent_memory(见 migration 040)。
 *
 * 旧 API(createNote/getNoteById/listNotesByGroup/updateNote/deleteNote)保留,
 * 内部操作 agent_memory 表,字段映射:
 *   note.title       → agent_memory.key
 *   note.description → agent_memory.value
 * 新建的 note 默认 agent_visible=0(纯人看,agent 搜不到),category='note'。
 *
 * 旧 /groups/:id/notes 路由 + rotom note CLI 走这层,保证向后兼容。
 */

import type { NoteRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

/** 把 agent_memory 行映射回旧 NoteRow 形状(title/description)。 */
function rowToNote(row: any): NoteRow {
  return {
    id: row.id,
    group_id: row.group_id,
    title: row.key,
    description: row.value,
    created_by: row.created_by ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const noteMethods = {
  createNote(this: MeshDbSelf, note: {
    id: string; groupId: string; title: string;
    description?: string; createdBy: string;
  }): void {
    const now = nowBeijing();
    this.db.prepare(`
      INSERT INTO agent_memory (
        id, group_id, scope, category, source_type, source_ref,
        key, value, summary, tags, visibility, agent_visible,
        created_by, created_at, updated_at, expires_at,
        active, pending_review, injected_count, view_count, last_viewed_at
      ) VALUES (?, ?, 'group', 'note', 'manual', NULL, ?, ?, ?, '[]', 'group', 0, ?, ?, ?, NULL, 1, 0, 0, 0, NULL)
    `).run(
      note.id, note.groupId, note.title,
      note.description || "", (note.description || "").slice(0, 80),
      note.createdBy, now, now,
    );
  },

  getNoteById(this: MeshDbSelf, id: string): NoteRow | undefined {
    const row = this.db.prepare("SELECT * FROM agent_memory WHERE id = ?").get(id);
    return row ? rowToNote(row) : undefined;
  },

  listNotesByGroup(this: MeshDbSelf, groupId: string): NoteRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM agent_memory WHERE group_id = ? AND active = 1 ORDER BY created_at DESC",
    ).all(groupId);
    return rows.map(rowToNote);
  },

  updateNote(this: MeshDbSelf, id: string, fields: { title?: string; description?: string }): boolean {
    const built = buildUpdate({
      table: "agent_memory",
      sets: {
        key: fields.title,
        value: fields.description,
        summary: fields.description !== undefined ? fields.description.slice(0, 80) : undefined,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "datetime-now",
    });
    if (!built) return false;
    const result = this.db.prepare(built.sql).run(...(built.params as never[]));
    return result.changes > 0;
  },

  deleteNote(this: MeshDbSelf, id: string): void {
    this.db.prepare("UPDATE agent_memory SET active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
  },
};
