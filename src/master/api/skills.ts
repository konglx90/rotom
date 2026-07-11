/**
 * Skill REST API —— 全局 skill 知识库 + (group, agent, skill) 绑定关系。
 *
 * Dashboard 端点开放(无登录),与 memory/notes 一致。
 * skill 本身无可见性;可见性靠 /groups/:id/skills/:agent/bind 端点绑定。
 */

import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

// ── 校验(对齐 Claude Code SKILL.md 规范)───────────────────────────────
// name: 小写字母/数字/短横线,首字符非短横线,长度 1-64。禁中文/空格/斜杠。
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;  // Claude Code 合计 1536,留余量给 when_to_use

function validateSkillFields(input: { name?: string; description?: string; content?: string }): string | null {
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) return "name 不能为空";
    if (n.length > MAX_NAME) return `name 长度超过 ${MAX_NAME}`;
    if (!NAME_RE.test(n)) return "name 只能用小写字母/数字/短横线,首字符非短横线(对齐 Claude Code skill 命名,禁中文/空格/斜杠)";
  }
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (!d) return "description 不能为空";
    if (d.length > MAX_DESCRIPTION) return `description 长度超过 ${MAX_DESCRIPTION}(建议说明「做什么 + 何时用」)`;
  }
  if (input.content !== undefined) {
    if (!input.content.trim()) return "content 不能为空";
  }
  return null;
}

export function registerSkillRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  // ── 全局 skill CRUD ──────────────────────────────────────────────────
  apiRouter.get("/skills", (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    res.json(db.listSkills({ category }));
  });

  apiRouter.get("/skills/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) { res.status(400).json({ error: "q is required" }); return; }
    res.json(db.searchSkills(q));
  });

  // ── 文件 ↔ DB 双向收敛(手动触发;boot 时已自动跑一次)──────────────────
  apiRouter.post("/skills/reconcile", (_req, res) => {
    const result = db.reconcileSkills();
    log.info(`Skill reconcile: +${result.added} added, ~${result.updated} updated, ↻${result.backfilled} backfilled`);
    res.json({ ok: true, ...result });
  });

  apiRouter.get("/skills/:name", (req, res) => {
    const row = db.getSkillByName(req.params.name);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    // getSkillByName 不计 view_count;手动 +1
    const full = db.getSkill(row.id);
    res.json(full);
  });

  apiRouter.post("/skills", (req, res) => {
    const { name, description, content, category, createdBy } = req.body;
    if (!name || !description || !content || !createdBy) {
      res.status(400).json({ error: "name, description, content, createdBy are required" }); return;
    }
    const validationErr = validateSkillFields({ name, description, content });
    if (validationErr) { res.status(400).json({ error: validationErr }); return; }
    const existing = db.getSkillByName(String(name).trim());
    if (existing) { res.status(409).json({ error: `skill "${name}" already exists` }); return; }
    const id = randomUUID();
    db.createSkill({
      id, name: String(name).trim(), description: String(description).trim(),
      content: String(content), category: category ?? null, createdBy,
    });
    log.info(`Skill created: "${name}" (${id})`);
    res.status(201).json({ id, name });
  });

  apiRouter.patch("/skills/:name", (req, res) => {
    const row = db.getSkillByName(req.params.name);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    const { name, description, content, category } = req.body;
    const validationErr = validateSkillFields({ name, description, content });
    if (validationErr) { res.status(400).json({ error: validationErr }); return; }
    const fields: Record<string, unknown> = {};
    if (name !== undefined) fields.name = String(name).trim();
    if (description !== undefined) fields.description = String(description).trim();
    if (content !== undefined) fields.content = String(content);
    if (category !== undefined) fields.category = category == null ? null : String(category);
    db.updateSkill(row.id, fields);
    res.json({ ok: true });
  });

  apiRouter.delete("/skills/:name", (req, res) => {
    const row = db.getSkillByName(req.params.name);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    db.deactivateSkill(row.id);
    res.json({ ok: true });
  });

  // ── 绑定关系 ──────────────────────────────────────────────────────────
  // 该 agent 在该群绑定的 skill 索引(供 agent `rotom skill mine` + prompt count)
  apiRouter.get("/groups/:groupId/skills/:agentName", (req, res) => {
    res.json(db.listSkillsForAgent(req.params.groupId, req.params.agentName));
  });

  apiRouter.post("/groups/:groupId/skills/:agentName/bind", (req, res) => {
    const { skillName, createdBy } = req.body;
    if (!skillName || !createdBy) {
      res.status(400).json({ error: "skillName, createdBy are required" }); return;
    }
    const skill = db.getSkillByName(String(skillName));
    if (!skill) { res.status(404).json({ error: `skill "${skillName}" not found` }); return; }
    const created = db.bindSkill({
      groupId: req.params.groupId,
      agentName: req.params.agentName,
      skillId: skill.id,
      createdBy,
    });
    res.json({ ok: true, created });
  });

  apiRouter.delete("/groups/:groupId/skills/:agentName/bind/:skillName", (req, res) => {
    const skill = db.getSkillByName(req.params.skillName);
    if (!skill) { res.json({ ok: true, removed: false }); return; }
    const removed = db.unbindSkill({
      groupId: req.params.groupId,
      agentName: req.params.agentName,
      skillId: skill.id,
    });
    res.json({ ok: true, removed });
  });

  // 群内所有绑定(群设置 modal 用)
  apiRouter.get("/groups/:groupId/skill-bindings", (req, res) => {
    const bindings = db.listBindings({ groupId: req.params.groupId });
    res.json(bindings.map(b => ({
      ...b,
      skill_name: db.getSkill(b.skill_id)?.name ?? null,
    })));
  });

  // 全局绑定总览(工具箱管理用)
  apiRouter.get("/skills/bindings/all", (req, res) => {
    const groupId = typeof req.query.groupId === "string" ? req.query.groupId : undefined;
    const agentName = typeof req.query.agentName === "string" ? req.query.agentName : undefined;
    const bindings = db.listBindings({ groupId, agentName });
    res.json(bindings.map(b => ({
      ...b,
      skill_name: db.getSkill(b.skill_id)?.name ?? null,
    })));
  });

  // ── playbook memory → skill ───────────────────────────────────────────
  apiRouter.post("/memory/:id/promote-to-skill", (req, res) => {
    const { name, description, createdBy } = req.body;
    if (!createdBy) { res.status(400).json({ error: "createdBy is required" }); return; }
    try {
      const result = db.promoteMemoryToSkill(req.params.id, { name, description, createdBy });
      log.info(`Memory ${req.params.id} promoted to skill "${result.name}" (${result.skillId})`);
      res.status(201).json(result);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
