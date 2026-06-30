import { nowBeijing } from "../../shared/time.js";
/**
 * Memory — 统一的记忆/便签载体(agent_memory 表)。
 *
 * 同一张表两个子集,用 agent_visible 区分:
 *   - agent_visible=0 → note(纯人看,agent search/get/prompt 全部排除)
 *   - agent_visible=1 → memory(agent 可见,走 search/get/注入)
 *
 * 旧 notes 数据 backfill 为 agent_visible=0,保持"agent 看不到"的现状。
 *
 * 所有 agent 可见的查询路径强制:
 *   agent_visible=1 AND pending_review=0 AND active=1
 *
 * Methods attach via Object.assign(见 internal.ts)。
 */

import type { MeshDbSelf } from "./core.js";

// ─── Row types ────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  group_id: string | null;
  scope: "group" | "global";
  category: "fact" | "decision" | "convention" | "pitfall" | "todo" | "playbook" | "note";
  source_type: "manual" | "issue_summary";
  source_ref: string | null;
  key: string;
  value: string;
  summary: string | null;
  tags: string;
  visibility: "private" | "group" | "global";
  agent_visible: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  active: number;
  pending_review: number;
  injected_count: number;
  view_count: number;
  last_viewed_at: string | null;
}

/** L1 列表/search 返回的轻量结构(不含 value 全文)。 */
export interface MemoryIndex {
  id: string;
  key: string;
  summary: string | null;
  tags: string;
  category: MemoryRow["category"];
  scope: MemoryRow["scope"];
  group_id: string | null;
  agent_visible: number;
  created_by: string | null;
  created_at: string;
}

export interface MemoryInput {
  id: string;
  scope?: "group" | "global";
  groupId?: string | null;
  category: MemoryRow["category"];
  sourceType?: "manual" | "issue_summary";
  sourceRef?: string | null;
  key: string;
  value: string;
  summary?: string | null;
  tags?: string[];
  visibility?: "private" | "group" | "global";
  agentVisible?: boolean;
  createdBy: string;
  expiresAt?: string | null;
  pendingReview?: boolean;
}

export interface MemoryListFilter {
  scope?: "group" | "global";
  groupId?: string;
  category?: MemoryRow["category"];
  key?: string;
  tags?: string[];
  includePending?: boolean;
  /** note(0) / memory(1) / all(undefined)。默认 all。 */
  agentVisible?: 0 | 1;
  limit?: number;
}

// ─── Methods ──────────────────────────────────────────────────────────────

export const memoryMethods = {
  /** 列表过滤。返回轻量索引(无 value 全文)。 */
  listMemory(this: MeshDbSelf, filter: MemoryListFilter = {}): MemoryIndex[] {
    const {
      scope, groupId, category, key, tags,
      includePending = false, agentVisible, limit = 50,
    } = filter;
    const where: string[] = ["active = 1"];
    const params: unknown[] = [];
    if (scope) { where.push("scope = ?"); params.push(scope); }
    if (groupId) { where.push("group_id = ?"); params.push(groupId); }
    if (category) { where.push("category = ?"); params.push(category); }
    if (key) { where.push("key = ?"); params.push(key); }
    if (agentVisible !== undefined) { where.push("agent_visible = ?"); params.push(agentVisible); }
    if (!includePending) { where.push("pending_review = 0"); }
    if (tags && tags.length > 0) {
      // JSON array LIKE 匹配
      const ors = tags.map(() => "tags LIKE ?");
      where.push(`(${ors.join(" OR ")})`);
      for (const t of tags) params.push(`%"${t.replace(/"/g, '\\"')}%"`);
    }
    params.push(limit);
    const rows = this.db.prepare(
      `SELECT id, key, summary, tags, category, scope, group_id, agent_visible,
              created_by, created_at
       FROM agent_memory
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(...params) as MemoryIndex[];
    return rows;
  },

  /**
   * 关键词搜索(SQL LIKE)。强制 agent_visible=1 AND pending_review=0 AND active=1
   * —— note(agent_visible=0)永远搜不到。
   * 命中时 injected_count += 1(计入"被检索到"统计)。
   */
  searchMemory(
    this: MeshDbSelf,
    keyword: string,
    filter: { scope?: "group" | "global"; groupId?: string; category?: MemoryRow["category"]; limit?: number } = {},
  ): MemoryIndex[] {
    const { scope, groupId, category, limit = 20 } = filter;
    const where: string[] = [
      "active = 1",
      "agent_visible = 1",
      "pending_review = 0",
    ];
    const params: unknown[] = [];
    const kw = `%${keyword}%`;
    // 在 key/value/summary/tags 上 LIKE
    where.push("(key LIKE ? OR value LIKE ? OR summary LIKE ? OR tags LIKE ?)");
    params.push(kw, kw, kw, kw);
    if (scope) { where.push("scope = ?"); params.push(scope); }
    if (groupId) { where.push("group_id = ?"); params.push(groupId); }
    if (category) { where.push("category = ?"); params.push(category); }
    params.push(limit);
    const rows = this.db.prepare(
      `SELECT id, key, summary, tags, category, scope, group_id, agent_visible,
              created_by, created_at
       FROM agent_memory
       WHERE ${where.join(" AND ")}
       ORDER BY view_count DESC, created_at DESC
       LIMIT ?`,
    ).all(...params) as MemoryIndex[];

    // 批量 injected_count += 1
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE agent_memory SET injected_count = injected_count + 1 WHERE id IN (${placeholders})`,
      ).run(...ids);
    }
    return rows;
  },

  /** 详情。memory(agent_visible=1) 读取时 view_count += 1;note 不计数。 */
  getMemory(this: MeshDbSelf, id: string): MemoryRow | undefined {
    const row = this.db.prepare("SELECT * FROM agent_memory WHERE id = ?").get(id) as MemoryRow | undefined;
    if (!row) return undefined;
    if (row.agent_visible === 1 && row.active === 1 && row.pending_review === 0) {
      this.db.prepare(
        `UPDATE agent_memory SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?`,
      ).run(id);
    }
    return row;
  },

  /** 计数 agent_visible=1 的 memory(供 prompt 极简指针注入)。 */
  countMemory(this: MeshDbSelf, scope: "group" | "global", groupId?: string): number {
    const where = ["active = 1", "agent_visible = 1", "pending_review = 0", "scope = ?"];
    const params: unknown[] = [scope];
    if (scope === "group" && groupId) { where.push("group_id = ?"); params.push(groupId); }
    const row = this.db.prepare(
      `SELECT COUNT(*) as n FROM agent_memory WHERE ${where.join(" AND ")}`,
    ).get(...params) as { n: number };
    return row?.n ?? 0;
  },

  addMemory(this: MeshDbSelf, input: MemoryInput): void {
    const now = nowBeijing();
    const summary = input.summary ?? input.value.slice(0, 80);
    const scope = input.scope ?? "group";
    const groupId = scope === "global" ? null : (input.groupId ?? null);
    this.db.prepare(`
      INSERT INTO agent_memory (
        id, group_id, scope, category, source_type, source_ref,
        key, value, summary, tags, visibility, agent_visible,
        created_by, created_at, updated_at, expires_at,
        active, pending_review, injected_count, view_count, last_viewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, NULL)
    `).run(
      input.id, groupId, scope, input.category,
      input.sourceType ?? "manual", input.sourceRef ?? null,
      input.key, input.value, summary,
      JSON.stringify(input.tags ?? []), input.visibility ?? "group",
      input.agentVisible ? 1 : 0,
      input.createdBy, now, now, input.expiresAt ?? null,
      input.pendingReview ? 1 : 0,
    );
  },

  updateMemory(
    this: MeshDbSelf,
    id: string,
    fields: {
      value?: string; summary?: string; tags?: string[];
      category?: MemoryRow["category"]; visibility?: MemoryRow["visibility"];
      agentVisible?: boolean; expiresAt?: string | null;
    },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.value !== undefined) {
      sets.push("value = ?"); params.push(fields.value);
      // value 改了但 summary 没显式给 → 自动重算
      if (fields.summary === undefined) {
        sets.push("summary = ?"); params.push(fields.value.slice(0, 80));
      }
    }
    if (fields.summary !== undefined) { sets.push("summary = ?"); params.push(fields.summary); }
    if (fields.tags !== undefined) { sets.push("tags = ?"); params.push(JSON.stringify(fields.tags)); }
    if (fields.category !== undefined) { sets.push("category = ?"); params.push(fields.category); }
    if (fields.visibility !== undefined) { sets.push("visibility = ?"); params.push(fields.visibility); }
    if (fields.agentVisible !== undefined) { sets.push("agent_visible = ?"); params.push(fields.agentVisible ? 1 : 0); }
    if (fields.expiresAt !== undefined) { sets.push("expires_at = ?"); params.push(fields.expiresAt); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    const result = this.db.prepare(
      `UPDATE agent_memory SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...(params as never[]));
    return result.changes > 0;
  },

  /** 软删除:active=0。 */
  deactivateMemory(this: MeshDbSelf, id: string): boolean {
    const result = this.db.prepare(
      "UPDATE agent_memory SET active = 0, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  },

  /** 标记过期(仍 active=1,但 expires_at 设为过去时间;读取时由调用方判断)。 */
  expireMemory(this: MeshDbSelf, id: string): boolean {
    const result = this.db.prepare(
      "UPDATE agent_memory SET expires_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  },

  /** group → global(scope 随之变 global, group_id 置 NULL)。 */
  promoteMemoryVisibility(
    this: MeshDbSelf,
    id: string,
    newVisibility: "private" | "group" | "global",
  ): boolean {
    const sets = ["visibility = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [newVisibility];
    if (newVisibility === "global") {
      sets.push("scope = ?", "group_id = NULL");
      params.push("global");
    }
    params.push(id);
    const result = this.db.prepare(
      `UPDATE agent_memory SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...(params as never[]));
    return result.changes > 0;
  },

  /** 审核队列:pending_review=1。 */
  listPendingMemory(this: MeshDbSelf, scope?: "group" | "global", groupId?: string): MemoryIndex[] {
    const where = ["active = 1", "pending_review = 1"];
    const params: unknown[] = [];
    if (scope) { where.push("scope = ?"); params.push(scope); }
    if (groupId) { where.push("group_id = ?"); params.push(groupId); }
    return this.db.prepare(
      `SELECT id, key, summary, tags, category, scope, group_id, agent_visible,
              created_by, created_at
       FROM agent_memory
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC`,
    ).all(...params) as MemoryIndex[];
  },

  /** 审核通过:pending_review=0,隐含 agent_visible=1(审核通过即对 agent 可见)。 */
  approveMemory(this: MeshDbSelf, id: string): boolean {
    const result = this.db.prepare(
      `UPDATE agent_memory SET pending_review = 0, agent_visible = 1, updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
    return result.changes > 0;
  },

  /** 审核拒绝:active=0。 */
  rejectMemory(this: MeshDbSelf, id: string): boolean {
    const result = this.db.prepare(
      "UPDATE agent_memory SET active = 0, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  },

  /** 死记忆:view_count=0 && age > minAgeDays(只看 agent_visible=1)。 */
  listStaleMemory(
    this: MeshDbSelf,
    filter: { scope?: "group" | "global"; groupId?: string; minAgeDays?: number } = {},
  ): MemoryIndex[] {
    const { scope, groupId, minAgeDays = 30 } = filter;
    const where = [
      "active = 1", "agent_visible = 1", "pending_review = 0", "view_count = 0",
      `created_at < datetime('now', '-${minAgeDays} days')`,
    ];
    const params: unknown[] = [];
    if (scope) { where.push("scope = ?"); params.push(scope); }
    if (groupId) { where.push("group_id = ?"); params.push(groupId); }
    return this.db.prepare(
      `SELECT id, key, summary, tags, category, scope, group_id, agent_visible,
              created_by, created_at
       FROM agent_memory
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC`,
    ).all(...params) as MemoryIndex[];
  },

  /** 聚合统计。 */
  memoryStats(this: MeshDbSelf, scope?: "group" | "global", groupId?: string): {
    total: number; active: number; pending: number;
    byCategory: Record<string, number>;
    byAgentVisible: { note: number; memory: number };
    topViewed: MemoryIndex[];
  } {
    const where = ["1=1"];
    const params: unknown[] = [];
    if (scope) { where.push("scope = ?"); params.push(scope); }
    if (groupId) { where.push("group_id = ?"); params.push(groupId); }
    const base = `FROM agent_memory WHERE ${where.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) as n ${base}`).get(...params) as { n: number }).n;
    const active = (this.db.prepare(`SELECT COUNT(*) as n ${base} AND active = 1`).get(...params) as { n: number }).n;
    const pending = (this.db.prepare(`SELECT COUNT(*) as n ${base} AND active = 1 AND pending_review = 1`).get(...params) as { n: number }).n;
    const byCatRows = this.db.prepare(
      `SELECT category, COUNT(*) as n ${base} AND active = 1 GROUP BY category`,
    ).all(...params) as { category: string; n: number }[];
    const byCategory: Record<string, number> = {};
    for (const r of byCatRows) byCategory[r.category] = r.n;
    const noteN = (this.db.prepare(`SELECT COUNT(*) as n ${base} AND active = 1 AND agent_visible = 0`).get(...params) as { n: number }).n;
    const memN = (this.db.prepare(`SELECT COUNT(*) as n ${base} AND active = 1 AND agent_visible = 1`).get(...params) as { n: number }).n;
    const topViewed = this.db.prepare(
      `SELECT id, key, summary, tags, category, scope, group_id, agent_visible, created_by, created_at
       ${base} AND active = 1 AND agent_visible = 1
       ORDER BY view_count DESC LIMIT 5`,
    ).all(...params) as MemoryIndex[];
    return {
      total, active, pending, byCategory,
      byAgentVisible: { note: noteN, memory: memN },
      topViewed,
    };
  },
};
