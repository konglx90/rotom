/**
 * Skills — 全局 skill 知识库 + (group, agent, skill) 绑定关系。
 *
 * skill 本身不带可见性:它是全局能力资产。
 * 可见性靠 agent_skill_bindings 表达:某群的某 agent 持有某 skill。
 *
 * agent 执行时按 (group, agent) 查绑定,countSkillsForAgent 供 prompt 极简指针,
 * listSkillsForAgent 供 agent `rotom skill mine` 拉取可见 skill 列表。
 *
 * Methods attach via Object.assign(见 internal.ts)。
 */

import type { MeshDbSelf } from "./core.js";

// ─── Row types ────────────────────────────────────────────────────────────

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string | null;
  source_type: "manual" | "promoted";
  source_ref: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  active: number;
  view_count: number;
  last_viewed_at: string | null;
}

/** L1 索引(不含 content 全文)。 */
export interface SkillIndex {
  id: string;
  name: string;
  description: string;
  category: string | null;
  source_type: "manual" | "promoted";
  created_by: string;
  created_at: string;
  view_count: number;
}

export interface SkillBindingRow {
  id: number;
  group_id: string;
  agent_name: string;
  skill_id: string;
  created_by: string;
  created_at: string;
}

export interface SkillInput {
  id: string;
  name: string;
  description: string;
  content: string;
  category?: string | null;
  sourceType?: "manual" | "promoted";
  sourceRef?: string | null;
  createdBy: string;
}

// ─── Methods ──────────────────────────────────────────────────────────────

export const skillMethods = {
  /** 全局 skill 索引(不含 content)。默认只返回 active。 */
  listSkills(this: MeshDbSelf, filter: { category?: string; activeOnly?: boolean } = {}): SkillIndex[] {
    const { category, activeOnly = true } = filter;
    const where: string[] = [];
    const params: unknown[] = [];
    if (activeOnly) { where.push("active = 1"); }
    if (category) { where.push("category = ?"); params.push(category); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT id, name, description, category, source_type, created_by, created_at, view_count
       FROM agent_skills ${whereClause} ORDER BY name ASC`,
    ).all(...params) as SkillIndex[];
  },

  /** 关键词搜索(LIKE 匹配 name/description/category/content)。只搜 active。 */
  searchSkills(this: MeshDbSelf, keyword: string): SkillIndex[] {
    const kw = `%${keyword}%`;
    return this.db.prepare(
      `SELECT id, name, description, category, source_type, created_by, created_at, view_count
       FROM agent_skills
       WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR category LIKE ? OR content LIKE ?)
       ORDER BY view_count DESC, name ASC`,
    ).all(kw, kw, kw, kw) as SkillIndex[];
  },

  /** 详情(content 全文)。view_count += 1。 */
  getSkill(this: MeshDbSelf, id: string): SkillRow | undefined {
    const row = this.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id) as SkillRow | undefined;
    if (!row) return undefined;
    if (row.active === 1) {
      this.db.prepare(
        "UPDATE agent_skills SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?",
      ).run(id);
    }
    return row;
  },

  getSkillByName(this: MeshDbSelf, name: string): SkillRow | undefined {
    return this.db.prepare("SELECT * FROM agent_skills WHERE name = ?").get(name) as SkillRow | undefined;
  },

  createSkill(this: MeshDbSelf, input: SkillInput): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)
    `).run(
      input.id, input.name, input.description, input.content,
      input.category ?? null, input.sourceType ?? "manual", input.sourceRef ?? null,
      input.createdBy, now, now,
    );
  },

  updateSkill(
    this: MeshDbSelf,
    id: string,
    fields: { name?: string; description?: string; content?: string; category?: string | null },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
    if (fields.description !== undefined) { sets.push("description = ?"); params.push(fields.description); }
    if (fields.content !== undefined) { sets.push("content = ?"); params.push(fields.content); }
    if (fields.category !== undefined) { sets.push("category = ?"); params.push(fields.category); }
    if (sets.length === 0) return false;
    sets.push("updated_at = datetime('now')");
    params.push(id);
    const result = this.db.prepare(
      `UPDATE agent_skills SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...(params as never[]));
    return result.changes > 0;
  },

  deactivateSkill(this: MeshDbSelf, id: string): boolean {
    const result = this.db.prepare(
      "UPDATE agent_skills SET active = 0, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  },

  // ─── 绑定关系 ───────────────────────────────────────────────────────────

  /** 绑定 (group, agent, skill)。UNIQUE 冲突时 ignore。 */
  bindSkill(this: MeshDbSelf, input: { groupId: string; agentName: string; skillId: string; createdBy: string }): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO agent_skill_bindings (group_id, agent_name, skill_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.groupId, input.agentName, input.skillId, input.createdBy, now);
    return result.changes > 0;
  },

  unbindSkill(this: MeshDbSelf, input: { groupId: string; agentName: string; skillId: string }): boolean {
    const result = this.db.prepare(
      "DELETE FROM agent_skill_bindings WHERE group_id = ? AND agent_name = ? AND skill_id = ?",
    ).run(input.groupId, input.agentName, input.skillId);
    return result.changes > 0;
  },

  /** 绑定关系查询(群设置/工具箱管理用)。 */
  listBindings(this: MeshDbSelf, filter: { groupId?: string; agentName?: string; skillId?: string } = {}): SkillBindingRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.groupId) { where.push("group_id = ?"); params.push(filter.groupId); }
    if (filter.agentName) { where.push("agent_name = ?"); params.push(filter.agentName); }
    if (filter.skillId) { where.push("skill_id = ?"); params.push(filter.skillId); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db.prepare(
      `SELECT * FROM agent_skill_bindings ${whereClause} ORDER BY created_at DESC`,
    ).all(...params) as SkillBindingRow[];
  },

  /** 该 agent 在该群绑定的 skill 数(供 prompt 极简指针)。只算 active skill。 */
  countSkillsForAgent(this: MeshDbSelf, groupId: string, agentName: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as n
       FROM agent_skill_bindings b
       JOIN agent_skills s ON s.id = b.skill_id
       WHERE b.group_id = ? AND b.agent_name = ? AND s.active = 1`,
    ).get(groupId, agentName) as { n: number };
    return row?.n ?? 0;
  },

  /** 该 agent 在该群绑定的 skill 索引(供 agent `rotom skill mine` 拉取)。 */
  listSkillsForAgent(this: MeshDbSelf, groupId: string, agentName: string): SkillIndex[] {
    return this.db.prepare(
      `SELECT s.id, s.name, s.description, s.category, s.source_type, s.created_by, s.created_at, s.view_count
       FROM agent_skill_bindings b
       JOIN agent_skills s ON s.id = b.skill_id
       WHERE b.group_id = ? AND b.agent_name = ? AND s.active = 1
       ORDER BY s.name ASC`,
    ).all(groupId, agentName) as SkillIndex[];
  },

  // ─── playbook memory → skill 沉淀 ───────────────────────────────────────

  /** 把一条 playbook memory 升级成 skill。
   *  memory.value → skill.content,memory.key → skill.name(或显式),
   *  memory.summary → skill.description(或显式)。
   *  memory 保留 active=1,skill.source_ref 指向 memory_id。 */
  promoteMemoryToSkill(
    this: MeshDbSelf,
    memoryId: string,
    opts: { name?: string; description?: string; createdBy: string },
  ): { skillId: string; name: string } {
    const mem = this.db.prepare("SELECT * FROM agent_memory WHERE id = ?").get(memoryId) as any;
    if (!mem) throw new Error(`memory ${memoryId} not found`);
    const name = (opts.name ?? mem.key).trim();
    if (!name) throw new Error("skill name 不能为空(memory.key 为空且未传 --name)");
    const description = (opts.description ?? mem.summary ?? mem.value.slice(0, 120)).trim();
    const skillId = randomUUIDLike();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
      VALUES (?, ?, ?, ?, 'playbook', 'promoted', ?, ?, ?, ?, 1, 0, NULL)
    `).run(skillId, name, description, mem.value, memoryId, opts.createdBy, now, now);
    return { skillId, name };
  },
};

/** 生成 UUID-like ID(避免引入 crypto 依赖到 db 层,用 Date+random 兜底)。
 *  调用方一般用 randomUUID;promote 路径在 db 层内自调,用此兜底。 */
function randomUUIDLike(): string {
  return `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
