/**
 * Notes — minimal text records inside a group (no execution flow).
 *
 * Pure CRUD: title + description, both nullable, no events.
 * Methods attach via `Object.assign`.
 */

import type { NoteRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

export const noteMethods = {
  createNote(this: MeshDbSelf, note: {
    id: string; groupId: string; title: string;
    description?: string; createdBy: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO notes (id, group_id, title, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      note.id, note.groupId, note.title,
      note.description || "", note.createdBy,
      now, now,
    );
  },

  getNoteById(this: MeshDbSelf, id: string): NoteRow | undefined {
    return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  },

  listNotesByGroup(this: MeshDbSelf, groupId: string): NoteRow[] {
    return this.db.prepare(
      "SELECT * FROM notes WHERE group_id = ? ORDER BY created_at DESC",
    ).all(groupId) as NoteRow[];
  },

  updateNote(this: MeshDbSelf, id: string, fields: { title?: string; description?: string }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    const result = this.db.prepare(
      `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...(params as never[]));
    return result.changes > 0;
  },

  deleteNote(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  },
};