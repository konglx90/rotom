/**
 * Memory REST API —— agent_memory 表的 CRUD + search + 审核 + 统计。
 *
 * Dashboard 端点开放(无登录),与 notes 一致。agent-token 端点走 Bearer header。
 * 旧 /groups/:id/notes 路由保留在 notes.ts,作为兼容层。
 */

import { type Router as ExpressRouter } from "express";
import { generateShortId } from "../../shared/short-id.js";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

const CATEGORIES = ["fact", "decision", "convention", "pitfall", "todo", "playbook", "note"] as const;
type Category = typeof CATEGORIES[number];

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export function registerMemoryRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  // ── 列表(支持 type=note|memory|all)─────────────────────────────────
  apiRouter.get("/groups/:groupId/memory", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const { category, key, tags, includePending, type } = req.query;
    const tagArr = typeof tags === "string" ? tags.split(",").map(t => t.trim()).filter(Boolean) : undefined;
    let agentVisible: 0 | 1 | undefined;
    if (type === "note") agentVisible = 0;
    else if (type === "memory") agentVisible = 1;
    // type=all 或未指定 → undefined(两者都查)
    res.json(db.listMemory({
      scope: "group",
      groupId: req.params.groupId,
      category: isCategory(category) ? category : undefined,
      key: typeof key === "string" ? key : undefined,
      tags: tagArr,
      includePending: includePending === "true" || includePending === "1",
      agentVisible,
    }));
  });

  // ── 全局记忆列表 ─────────────────────────────────────────────────────
  apiRouter.get("/memory/global", (req, res) => {
    const { category, key, tags, includePending, type } = req.query;
    const tagArr = typeof tags === "string" ? tags.split(",").map(t => t.trim()).filter(Boolean) : undefined;
    let agentVisible: 0 | 1 | undefined;
    if (type === "note") agentVisible = 0;
    else if (type === "memory") agentVisible = 1;
    res.json(db.listMemory({
      scope: "global",
      category: isCategory(category) ? category : undefined,
      key: typeof key === "string" ? key : undefined,
      tags: tagArr,
      includePending: includePending === "true" || includePending === "1",
      agentVisible,
    }));
  });

  // ── 关键词搜索(强制 agent_visible=1)──────────────────────────────────
  apiRouter.get("/groups/:groupId/memory/search", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) { res.status(400).json({ error: "q (keyword) is required" }); return; }
    const { category } = req.query;
    // 群内 + 全局都搜
    const groupHits = db.searchMemory(q, { scope: "group", groupId: req.params.groupId, category: isCategory(category) ? category : undefined });
    const globalHits = db.searchMemory(q, { scope: "global", category: isCategory(category) ? category : undefined });
    res.json({ group: groupHits, global: globalHits });
  });

  apiRouter.get("/memory/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) { res.status(400).json({ error: "q (keyword) is required" }); return; }
    const { category, scope, groupId } = req.query;
    res.json(db.searchMemory(q, {
      scope: scope === "global" || scope === "group" ? scope : undefined,
      groupId: typeof groupId === "string" ? groupId : undefined,
      category: isCategory(category) ? category : undefined,
    }));
  });

  // ── 详情(memory 读时计 view_count;note 不计)────────────────────────
  apiRouter.get("/memory/:id", (req, res) => {
    const row = db.getMemory(req.params.id);
    if (!row) { res.status(404).json({ error: "Memory not found" }); return; }
    res.json(row);
  });

  // ── 新建(支持 agent_visible,默认 true=memory)───────────────────────
  apiRouter.post("/groups/:groupId/memory", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived" }); return; }
    const { key, value, summary, tags, category, visibility, agentVisible, createdBy, expiresAt, pendingReview } = req.body;
    if (!key || !value || !createdBy) {
      res.status(400).json({ error: "key, value, createdBy are required" }); return;
    }
    if (!isCategory(category)) {
      res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(",")}` }); return;
    }
    const id = generateShortId();
    db.addMemory({
      id, scope: "group", groupId: req.params.groupId,
      category, key: String(key).trim(), value: String(value),
      summary: summary == null ? undefined : String(summary),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      visibility: visibility === "private" || visibility === "global" ? visibility : "group",
      agentVisible: agentVisible === false ? false : true,
      createdBy,
      expiresAt: expiresAt == null ? null : String(expiresAt),
      pendingReview: pendingReview === true,
    });
    log.info(`Memory created: "${key}" (${id}) cat=${category} pending=${pendingReview === true} in group ${req.params.groupId}`);
    res.status(201).json({ id });
  });

  apiRouter.post("/memory/global", (req, res) => {
    const { key, value, summary, tags, category, visibility, createdBy, expiresAt } = req.body;
    if (!key || !value || !createdBy) {
      res.status(400).json({ error: "key, value, createdBy are required" }); return;
    }
    if (!isCategory(category)) {
      res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(",")}` }); return;
    }
    // 全局 memory 强制走审核:agent_visible=0 + pending_review=1,等人工 approve。
    // 已有 memory 想升级到 global,走 PATCH /memory/:id body { visibility: "global" }(走 promoteMemoryVisibility 路径)。
    // 原因:全局 memory 直接对所有 agent 可见影响面大,必须有真人拍板。
    const id = generateShortId();
    db.addMemory({
      id, scope: "global", groupId: null,
      category, key: String(key).trim(), value: String(value),
      summary: summary == null ? undefined : String(summary),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      visibility: visibility === "private" || visibility === "group" ? visibility : "global",
      agentVisible: false,        // 强制:global memory 创建时对 agent 不可见
      createdBy,
      expiresAt: expiresAt == null ? null : String(expiresAt),
      pendingReview: true,        // 强制:必须等人工 approve
    });
    log.info(`Global memory created (pending review): "${key}" (${id}) cat=${category}`);
    res.status(201).json({ id, pendingReview: true });
  });

  // ── 更新(可切换 agent_visible:note↔memory)───────────────────────────
  apiRouter.patch("/memory/:id", (req, res) => {
    const row = db.getMemory(req.params.id);
    if (!row) { res.status(404).json({ error: "Memory not found" }); return; }
    const { value, summary, tags, category, visibility, agentVisible, expiresAt } = req.body;
    const fields: Record<string, unknown> = {};
    if (value !== undefined) fields.value = String(value);
    if (summary !== undefined) fields.summary = String(summary);
    if (tags !== undefined) fields.tags = Array.isArray(tags) ? tags.map(String) : [];
    if (isCategory(category)) fields.category = category;
    if (visibility === "private" || visibility === "group" || visibility === "global") fields.visibility = visibility;
    if (agentVisible !== undefined) fields.agentVisible = !!agentVisible;
    if (expiresAt !== undefined) fields.expiresAt = expiresAt == null ? null : String(expiresAt);
    db.updateMemory(req.params.id, fields);
    res.json({ ok: true });
  });

  apiRouter.delete("/memory/:id", (req, res) => {
    const row = db.getMemory(req.params.id);
    if (!row) { res.status(404).json({ error: "Memory not found" }); return; }
    db.deactivateMemory(req.params.id);
    res.json({ ok: true });
  });

  apiRouter.post("/memory/:id/promote", (req, res) => {
    const row = db.getMemory(req.params.id);
    if (!row) { res.status(404).json({ error: "Memory not found" }); return; }
    const target = req.body?.visibility === "global" ? "global" : req.body?.visibility === "private" ? "private" : "global";
    db.promoteMemoryVisibility(req.params.id, target);
    res.json({ ok: true });
  });

  apiRouter.post("/memory/:id/expire", (req, res) => {
    const row = db.getMemory(req.params.id);
    if (!row) { res.status(404).json({ error: "Memory not found" }); return; }
    db.expireMemory(req.params.id);
    res.json({ ok: true });
  });

  // ── 审核 ──────────────────────────────────────────────────────────────
  apiRouter.get("/groups/:groupId/memory/pending", (req, res) => {
    res.json(db.listPendingMemory("group", req.params.groupId));
  });

  apiRouter.get("/memory/pending", (req, res) => {
    const { scope } = req.query;
    res.json(db.listPendingMemory(scope === "global" || scope === "group" ? scope : undefined));
  });

  apiRouter.post("/memory/:id/approve", (req, res) => {
    if (!db.getMemory(req.params.id)) { res.status(404).json({ error: "Memory not found" }); return; }
    db.approveMemory(req.params.id);
    res.json({ ok: true });
  });

  apiRouter.post("/memory/:id/reject", (req, res) => {
    if (!db.getMemory(req.params.id)) { res.status(404).json({ error: "Memory not found" }); return; }
    db.rejectMemory(req.params.id);
    res.json({ ok: true });
  });

  // ── 统计 ──────────────────────────────────────────────────────────────
  apiRouter.get("/groups/:groupId/memory/stats", (req, res) => {
    res.json(db.memoryStats("group", req.params.groupId));
  });

  apiRouter.get("/memory/stats", (req, res) => {
    const { scope } = req.query;
    res.json(db.memoryStats(scope === "global" || scope === "group" ? scope : undefined));
  });

  // ── count(供 prompt 注入,轻量)──────────────────────────────────────
  apiRouter.get("/groups/:groupId/memory/count", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    res.json({
      group: db.countMemory("group", req.params.groupId),
      global: db.countMemory("global"),
    });
  });
}
