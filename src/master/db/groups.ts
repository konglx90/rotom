/**
 * Groups — group CRUD, member management, per-member working_dir overrides,
 * and the chat log (group_messages + composed_prompt snapshots).
 *
 * Methods attach to a `MeshDb` instance via `Object.assign`. The chat layer
 * (`getGroupMessages`) joins against `chat_message_prompts` for the dashboard
 * "分层组成" view — populated by worker when it runs prompt-composer.
 */

import type { MeshDbSelf } from "./core.js";

export interface GroupRow {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  working_dir: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  type: string | null;
  metadata: string;
}

export interface GroupMemberRow {
  agent_name: string;
  joined_at: string;
  working_dir: string | null;
}

export interface GroupMessageRow {
  id: number;
  sender: string;
  content: string;
  mentions: string;
  created_at: string;
  cancelled_at: string | null;
  composed_prompt: {
    layers: { layer: string; content: string; source: string }[];
    final: string;
    generated_at: string;
    prompt_version: string;
  } | null;
}

export const groupMethods = {
  createGroup(this: MeshDbSelf, id: string, name: string, createdBy?: string, workingDir?: string): void {
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, working_dir) VALUES (?, ?, ?, ?)",
    ).run(id, name, createdBy || null, workingDir || null);
  },

  updateGroupWorkingDir(this: MeshDbSelf, id: string, workingDir: string | null): void {
    this.db.prepare("UPDATE groups SET working_dir = ? WHERE id = ?")
      .run(workingDir, id);
  },

  updateGroupName(this: MeshDbSelf, id: string, name: string): void {
    this.db.prepare("UPDATE groups SET name = ? WHERE id = ?")
      .run(name, id);
  },

  /**
   * Toggle (or set explicitly) the per-group pinned_at timestamp.
   * Passing `null` unpins; passing a value pins to "now" (UTC string).
   */
  updateGroupPinned(this: MeshDbSelf, id: string, pinned: boolean): string | null {
    const next = pinned ? new Date().toISOString() : null;
    this.db.prepare("UPDATE groups SET pinned_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  },

  /**
   * Archive or unarchive a group. Archived groups are read-only: no new messages,
   * issues, or collaboration. Passing `true` sets archived_at to "now";
   * passing `false` clears it.
   */
  updateGroupArchived(this: MeshDbSelf, id: string, archived: boolean): string | null {
    const next = archived ? new Date().toISOString() : null;
    this.db.prepare("UPDATE groups SET archived_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  },

  /**
   * Returns the archived_at value of a group, or null if not archived.
   */
  isGroupArchived(this: MeshDbSelf, id: string): string | null {
    const row = this.db.prepare("SELECT archived_at FROM groups WHERE id = ?").get(id) as { archived_at: string | null } | undefined;
    return row?.archived_at ?? null;
  },

  /**
   * Backfill working_dir on legacy groups (NULL or empty). Caller supplies the
   * `compute` fn — kept out of db.ts so this module stays free of filesystem
   * conventions (homedir, ARTIFACTS_ROOT, etc.). Returns the list of (id, path)
   * pairs that were written, so the caller can mkdir each one.
   */
  backfillGroupDefaultWorkingDir(
    this: MeshDbSelf,
    compute: (id: string) => string,
  ): { id: string; workingDir: string }[] {
    const rows = this.db.prepare(
      "SELECT id FROM groups WHERE working_dir IS NULL OR working_dir = ''",
    ).all() as { id: string }[];
    if (rows.length === 0) return [];
    const update = this.db.prepare("UPDATE groups SET working_dir = ? WHERE id = ?");
    const filled: { id: string; workingDir: string }[] = [];
    const tx = this.db.transaction((items: { id: string }[]) => {
      for (const { id } of items) {
        const wd = compute(id);
        update.run(wd, id);
        filled.push({ id, workingDir: wd });
      }
    });
    tx(rows);
    return filled;
  },

  listGroups(this: MeshDbSelf): (GroupRow & { member_count: number })[] {
    return this.db.prepare(`
      SELECT g.*, COUNT(gm.agent_name) as member_count
      FROM groups g
      LEFT JOIN group_members gm ON g.id = gm.group_id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `).all() as (GroupRow & { member_count: number })[];
  },

  listGroupsWithMembers(this: MeshDbSelf): (GroupRow & { member_count: number; members: GroupMemberRow[] })[] {
    const groups = this.listGroups();
    const rows = this.db.prepare(`
      SELECT gm.group_id, gm.agent_name, gm.joined_at, gms.working_dir
      FROM group_members gm
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      ORDER BY gm.joined_at
    `).all() as { group_id: string; agent_name: string; joined_at: string; working_dir: string | null }[];
    const byGroup = new Map<string, GroupMemberRow[]>();
    for (const r of rows) {
      let list = byGroup.get(r.group_id);
      if (!list) {
        list = [];
        byGroup.set(r.group_id, list);
      }
      list.push({ agent_name: r.agent_name, joined_at: r.joined_at, working_dir: r.working_dir });
    }
    return groups.map((g) => ({ ...g, members: byGroup.get(g.id) ?? [] }));
  },

  getGroupById(this: MeshDbSelf, id: string): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  },

  deleteGroup(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM group_messages WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM group_member_settings WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  },

  /** Create group with type and metadata (for e2ed integration) */
  createGroupTyped(this: MeshDbSelf, opts: {
    id: string;
    name: string;
    type: string;
    createdBy?: string;
    workingDir?: string | null;
    metadata?: string;
  }): void {
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, working_dir, type, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(opts.id, opts.name, opts.createdBy || null, opts.workingDir || null, opts.type, opts.metadata || '{}');
  },

  /** Get group by id including type and metadata columns */
  getGroupByIdFull(this: MeshDbSelf, id: string): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  },

  /** List groups filtered by type */
  listGroupsByType(this: MeshDbSelf, type: string): GroupRow[] {
    return this.db.prepare(
      "SELECT id, name, created_by, created_at, working_dir, type, metadata FROM groups WHERE type = ? ORDER BY created_at DESC",
    ).all(type) as GroupRow[];
  },

  /** Update group metadata JSON */
  updateGroupMetadata(this: MeshDbSelf, id: string, metadata: string): void {
    this.db.prepare("UPDATE groups SET metadata = ? WHERE id = ?").run(metadata, id);
  },

  addGroupMembers(this: MeshDbSelf, groupId: string, agentNames: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO group_members (group_id, agent_name) VALUES (?, ?)",
    );
    for (const name of agentNames) {
      stmt.run(groupId, name);
    }
  },

  removeGroupMembers(this: MeshDbSelf, groupId: string, agentNames: string[]): void {
    const tx = this.db.transaction((names: string[]) => {
      const m = this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND agent_name = ?");
      const s = this.db.prepare("DELETE FROM group_member_settings WHERE group_id = ? AND agent_name = ?");
      for (const name of names) {
        m.run(groupId, name);
        s.run(groupId, name);
      }
    });
    tx(agentNames);
  },

  getGroupMembers(this: MeshDbSelf, groupId: string): GroupMemberRow[] {
    return this.db.prepare(`
      SELECT gm.agent_name, gm.joined_at, gms.working_dir
      FROM group_members gm
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at
    `).all(groupId) as GroupMemberRow[];
  },

  getGroupMemberSetting(this: MeshDbSelf, groupId: string, agentName: string): string | null {
    const row = this.db.prepare(
      "SELECT working_dir FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).get(groupId, agentName) as { working_dir: string } | undefined;
    return row?.working_dir ?? null;
  },

  listGroupMemberSettings(this: MeshDbSelf, groupId: string): { agent_name: string; working_dir: string; updated_at: string }[] {
    return this.db.prepare(
      "SELECT agent_name, working_dir, updated_at FROM group_member_settings WHERE group_id = ? ORDER BY agent_name",
    ).all(groupId) as { agent_name: string; working_dir: string; updated_at: string }[];
  },

  upsertGroupMemberSetting(this: MeshDbSelf, groupId: string, agentName: string, workingDir: string): void {
    this.db.prepare(`
      INSERT INTO group_member_settings (group_id, agent_name, working_dir, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, agent_name) DO UPDATE SET
        working_dir = excluded.working_dir,
        updated_at  = excluded.updated_at
    `).run(groupId, agentName, workingDir, new Date().toISOString());
  },

  clearGroupMemberSetting(this: MeshDbSelf, groupId: string, agentName: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).run(groupId, agentName);
    return result.changes > 0;
  },

  addGroupMessage(
    this: MeshDbSelf,
    groupId: string,
    sender: string,
    content: string,
    mentions: string[] = [],
    options?: { cancelledAt?: string },
  ): number {
    const result = this.db.prepare(
      "INSERT INTO group_messages (group_id, sender, content, mentions, cancelled_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      groupId,
      sender,
      content,
      JSON.stringify(mentions),
      options?.cancelledAt ?? null,
    );
    return Number(result.lastInsertRowid);
  },

  /**
   * 把 worker 算出的 ComposedPrompt 持久化到 chat_message_prompts,keyed by
   * group_messages.id。Dashboard 点击消息时读这张表渲染分层组成。
   */
  addChatMessagePrompt(
    this: MeshDbSelf,
    groupMessageId: number,
    layersJson: string,
    final: string,
    generatedAt: string,
    promptVersion: string,
  ): void {
    this.db.prepare(
      `INSERT INTO chat_message_prompts (group_message_id, layers, final, generated_at, prompt_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(groupMessageId, layersJson, final, generatedAt, promptVersion);
  },

  getChatMessagePrompt(this: MeshDbSelf, groupMessageId: number): {
    layers: { layer: string; content: string; source: string }[];
    final: string;
    generated_at: string;
    prompt_version: string;
  } | null {
    const row = this.db.prepare(
      `SELECT layers, final, generated_at, prompt_version
       FROM chat_message_prompts WHERE group_message_id = ?`,
    ).get(groupMessageId) as { layers: string; final: string; generated_at: string; prompt_version: string } | undefined;
    if (!row) return null;
    return {
      layers: JSON.parse(row.layers),
      final: row.final,
      generated_at: row.generated_at,
      prompt_version: row.prompt_version,
    };
  },

  getGroupMessages(this: MeshDbSelf, groupId: string, limit = 200): GroupMessageRow[] {
    const rows = this.db.prepare(
      `SELECT m.id, m.sender, m.content, m.mentions, m.created_at, m.cancelled_at,
              p.layers, p.final, p.generated_at, p.prompt_version
       FROM group_messages m
       LEFT JOIN chat_message_prompts p ON p.group_message_id = m.id
       WHERE m.group_id = ?
       ORDER BY m.created_at ASC
       LIMIT ?`,
    ).all(groupId, limit) as Array<{
      id: number; sender: string; content: string; mentions: string; created_at: string;
      cancelled_at: string | null;
      layers: string | null; final: string | null; generated_at: string | null; prompt_version: string | null;
    }>;
    return rows.map((r) => {
      let composed_prompt: {
        layers: { layer: string; content: string; source: string }[];
        final: string; generated_at: string; prompt_version: string;
      } | null = null;
      if (r.layers && r.final && r.generated_at && r.prompt_version) {
        composed_prompt = {
          layers: JSON.parse(r.layers),
          final: r.final,
          generated_at: r.generated_at,
          prompt_version: r.prompt_version,
        };
      }
      return {
        id: r.id, sender: r.sender, content: r.content, mentions: r.mentions, created_at: r.created_at,
        cancelled_at: r.cancelled_at,
        composed_prompt,
      };
    });
  },
};