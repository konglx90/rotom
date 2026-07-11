import { nowBeijing } from "../../shared/time.js";
import { buildUpdate } from "./build-update.js";
/**
 * Skills — 全局 skill 知识库 + (group, agent, skill) 绑定关系。
 *
 * skill 本身不带可见性:它是全局能力资产。
 * 可见性靠 agent_skill_bindings 表达:某群的某 agent 持有某 skill。
 *
 * agent 执行时按 (group, agent) 查绑定,countSkillsForAgent 供 prompt 极简指针,
 * listSkillsForAgent 供 agent `rotom skill mine` 拉取可见 skill 列表。
 *
 * ── 存储模型(Hybrid:文件 = 真相源,DB = 可重建索引)──────────────────────
 * skill 文档以 `~/.rotom/skills/<name>/SKILL.md` 落盘(frontmatter 元数据 +
 * markdown 正文),见 src/shared/skill-file.ts。DB `agent_skills` 表降级为索引:
 *   - listSkills / searchSkills / countSkillsForAgent / listSkillsForAgent
 *     全走 DB(快,无需读文件);
 *   - getSkill / getSkillByName 读「文件正文 + DB 运行时字段(view_count 等)」,
 *     文件优先 → agent / 人手编辑即时生效;
 *   - reconcileSkills() 双向收敛:文件→DB upsert、DB→文件 backfill,不主动
 *     deactivate(避免误删 migration seed 的 patrol rules)。
 *
 * Methods attach via Object.assign(见 internal.ts)。
 */

import type { MeshDbSelf } from "./core.js";
import {
  readSkillFile,
  writeSkillFile,
  trashSkillFile,
  renameSkillFile,
  listSkillNames,
  type SkillDoc,
} from "../../shared/skill-file.js";

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

/** reconcile 汇总。 */
export interface SkillReconcileResult {
  /** 新增:文件有、DB 无 → 插 DB 索引行。 */
  added: number;
  /** 更新:文件与 DB 都有、但描述/正文/分类漂移 → 同步到 DB。 */
  updated: number;
  /** 回填:DB active 行无文件 → 从 DB content 写出文件(migration 自愈)。 */
  backfilled: number;
}

// ─── 文件 ↔ 行 转换 ───────────────────────────────────────────────────────

/** 把 DB 行转成 SkillDoc(写文件用)。content 取 DB cache(回填用)。 */
function rowToDoc(row: SkillRow): SkillDoc {
  return {
    name: row.name,
    description: row.description,
    content: row.content,
    category: row.category,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 文件优先合并进 DB 行(getSkill / getSkillByName 用)。文件缺失则原样返回 DB 行。 */
function mergeFileIntoRow(row: SkillRow): SkillRow {
  const doc = readSkillFile(row.name);
  if (!doc) return row;
  return {
    ...row,
    name: doc.name || row.name,
    description: doc.description || row.description,
    content: doc.content ?? row.content,
    category: doc.category !== null && doc.category !== undefined ? doc.category : row.category,
    source_type: doc.sourceType || row.source_type,
    source_ref: doc.sourceRef ?? row.source_ref,
    created_by: doc.createdBy || row.created_by,
    created_at: doc.createdAt || row.created_at,
    updated_at: doc.updatedAt || row.updated_at,
  };
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

  /** 详情(content 全文,文件优先)。view_count += 1。 */
  getSkill(this: MeshDbSelf, id: string): SkillRow | undefined {
    const row = this.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id) as SkillRow | undefined;
    if (!row) return undefined;
    if (row.active === 1) {
      this.db.prepare(
        "UPDATE agent_skills SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?",
      ).run(id);
    }
    return mergeFileIntoRow(row);
  },

  getSkillByName(this: MeshDbSelf, name: string): SkillRow | undefined {
    const row = this.db.prepare("SELECT * FROM agent_skills WHERE name = ?").get(name) as SkillRow | undefined;
    if (!row) return undefined;
    return mergeFileIntoRow(row);
  },

  createSkill(this: MeshDbSelf, input: SkillInput): void {
    const now = nowBeijing();
    // 文件 = 真相源:先落盘。
    writeSkillFile({
      name: input.name,
      description: input.description,
      content: input.content,
      category: input.category ?? null,
      sourceType: input.sourceType ?? "manual",
      sourceRef: input.sourceRef ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
    // DB 索引 + content cache(getSkill 在文件缺失时兜底)。
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
    const hasField =
      fields.name !== undefined ||
      fields.description !== undefined ||
      fields.content !== undefined ||
      fields.category !== undefined;
    if (!hasField) return false;

    const row = this.db.prepare("SELECT * FROM agent_skills WHERE id = ?").get(id) as SkillRow | undefined;
    if (!row) return false;

    const newName = fields.name !== undefined ? String(fields.name).trim() : row.name;
    const description = fields.description !== undefined ? String(fields.description).trim() : row.description;
    const content = fields.content !== undefined ? String(fields.content) : row.content;
    const category = fields.category !== undefined
      ? (fields.category == null ? null : String(fields.category))
      : row.category;

    // 文件:改名则移目录,再原子重写 SKILL.md(更新 frontmatter + 正文)。
    if (newName !== row.name) renameSkillFile(row.name, newName);
    writeSkillFile({
      name: newName,
      description,
      content,
      category,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: nowBeijing(),
    });

    // DB 索引 + content cache。
    const built = buildUpdate({
      table: "agent_skills",
      sets: {
        name: fields.name,
        description: fields.description,
        content: fields.content,
        category: fields.category,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "datetime-now",
    });
    if (!built) return true;
    const result = this.db.prepare(built.sql).run(...(built.params as never[]));
    return result.changes > 0;
  },

  deactivateSkill(this: MeshDbSelf, id: string): boolean {
    const row = this.db.prepare("SELECT name FROM agent_skills WHERE id = ?").get(id) as { name: string } | undefined;
    if (row?.name) trashSkillFile(row.name);  // 文件移到 .trash(可恢复)
    const result = this.db.prepare(
      "UPDATE agent_skills SET active = 0, updated_at = datetime('now') WHERE id = ?",
    ).run(id);
    return result.changes > 0;
  },

  // ─── 绑定关系 ───────────────────────────────────────────────────────────

  /** 绑定 (group, agent, skill)。UNIQUE 冲突时 ignore。 */
  bindSkill(this: MeshDbSelf, input: { groupId: string; agentName: string; skillId: string; createdBy: string }): boolean {
    const now = nowBeijing();
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
    const now = nowBeijing();
    writeSkillFile({
      name,
      description,
      content: mem.value,
      category: "playbook",
      sourceType: "promoted",
      sourceRef: memoryId,
      createdBy: opts.createdBy,
      createdAt: now,
      updatedAt: now,
    });
    this.db.prepare(`
      INSERT INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
      VALUES (?, ?, ?, ?, 'playbook', 'promoted', ?, ?, ?, ?, 1, 0, NULL)
    `).run(skillId, name, description, mem.value, memoryId, opts.createdBy, now, now);
    return { skillId, name };
  },

  // ─── 文件 ↔ DB 双向收敛 ─────────────────────────────────────────────────

  /** 把文件系统(真相源)与 DB 索引双向收敛。幂等。master boot 时调 + CLI
   *  `rotom skill reconcile` 显式调。
   *
   *  - 文件有、DB 无 → 插 DB 索引行(added);
   *  - 文件有、DB 有、但 description/content/category 漂移 → 同步到 DB(updated);
   *  - DB active 行、文件无 → 从 DB content 写出文件(backfilled,自愈,不 deactivate)。
   *
   *  刻意不主动 deactivate:避免新装机 migration seed 的 patrol rules 因无文件被清空。
   *  显式删除走 deactivateSkill(移 .trash + active=0)。 */
  reconcileSkills(this: MeshDbSelf): SkillReconcileResult {
    const result: SkillReconcileResult = { added: 0, updated: 0, backfilled: 0 };
    // 不对 skillsRoot() 做 existsSync 早退:首装时目录不存在,listSkillNames() 返回
    // [] → upsert 无操作;backfill 分支会经 writeSkillFile 自动建目录把 DB skill
    // 落盘。这就是 migration 的自愈路径。本函数只 add/update/backfill,从不 deactivate。

    // 1) 文件 → DB upsert。
    const fileNames = new Set<string>();
    for (const name of listSkillNames()) {
      fileNames.add(name);
      const doc = readSkillFile(name);
      if (!doc) continue;
      const description = doc.description || "";
      const content = doc.content ?? "";
      const category = doc.category ?? null;

      const existing = this.db.prepare("SELECT id, description, content, category FROM agent_skills WHERE name = ?")
        .get(name) as { id: string; description: string; content: string; category: string | null } | undefined;
      if (existing) {
        if (existing.description !== description || existing.content !== content || (existing.category ?? null) !== (category ?? null)) {
          this.db.prepare(
            `UPDATE agent_skills SET description = ?, content = ?, category = ?, active = 1, updated_at = datetime('now') WHERE id = ?`,
          ).run(description, content, category, existing.id);
          result.updated++;
        }
      } else {
        const skillId = randomUUIDLike();
        const now = nowBeijing();
        this.db.prepare(`
          INSERT INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL)
        `).run(
          skillId, name, description, content, category,
          doc.sourceType || "manual", doc.sourceRef ?? null, doc.createdBy || "system",
          doc.createdAt || now, now,
        );
        result.added++;
      }
    }

    // 2) DB active 行、文件无 → backfill 文件(从 DB content)。不 deactivate。
    const activeRows = this.db.prepare("SELECT * FROM agent_skills WHERE active = 1").all() as SkillRow[];
    for (const row of activeRows) {
      if (!fileNames.has(row.name)) {
        writeSkillFile(rowToDoc(row));
        result.backfilled++;
      }
    }

    return result;
  },
};

/** 生成 UUID-like ID(避免引入 crypto 依赖到 db 层,用 Date+random 兜底)。
 *  调用方一般用 randomUUID;promote / reconcile 路径在 db 层内自调,用此兜底。 */
function randomUUIDLike(): string {
  return `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
