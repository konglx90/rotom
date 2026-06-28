/**
 * /api/guidance-templates — 群指导 prompt 模板库 CRUD
 *
 * - 列表: GET /api/guidance-templates
 * - 新建: POST /api/guidance-templates
 * - 改:   PATCH /api/guidance-templates/:id
 * - 删:   DELETE /api/guidance-templates/:id  (种子模板 is_default=1 返回 400)
 *
 * 身份验证沿用 api/index.ts 的 permissive middleware。
 */

import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api-guidance-templates");

interface CreateBody {
  name?: unknown;
  description?: unknown;
  prompt_text?: unknown;
  schedule_config?: unknown;
  sort_order?: unknown;
}

interface UpdateBody {
  name?: unknown;
  description?: unknown;
  prompt_text?: unknown;
  schedule_config?: unknown;
  sort_order?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return undefined;
}

/**
 * schedule_config 接受对象或 JSON 字符串;null/空串/缺省=不设置(返回 null)。
 * 返回 undefined 表示「格式非法」,由调用方返回 400。
 */
function normalizeScheduleConfig(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    try {
      JSON.parse(v);
      return v;
    } catch {
      return undefined;
    }
  }
  if (typeof v === "object") {
    return JSON.stringify(v);
  }
  return undefined;
}

export function registerGuidanceTemplateRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  // ── 列表 ─────────────────────────────────────────────────────────────────
  apiRouter.get("/guidance-templates", (_req, res) => {
    res.json(db.listGuidanceTemplates());
  });

  // ── 新建 ─────────────────────────────────────────────────────────────────
  apiRouter.post("/guidance-templates", (req, res) => {
    const b = req.body as CreateBody;
    const name = asString(b.name);
    const promptText = asString(b.prompt_text);
    if (!name) { res.status(400).json({ error: "name is required" }); return; }
    if (!promptText) { res.status(400).json({ error: "prompt_text is required" }); return; }

    const scheduleConfig = normalizeScheduleConfig(b.schedule_config);
    if (scheduleConfig === undefined) {
      res.status(400).json({ error: "schedule_config must be a JSON object or JSON string" });
      return;
    }

    const tpl = db.createGuidanceTemplate({
      name,
      description: typeof b.description === "string" ? b.description : "",
      prompt_text: promptText,
      schedule_config: scheduleConfig,
      sort_order: asInt(b.sort_order) ?? 0,
    });
    log.info(`Guidance template created: #${tpl.id} "${tpl.name}"`);
    res.status(201).json(tpl);
  });

  // ── 改 ───────────────────────────────────────────────────────────────────
  apiRouter.patch("/guidance-templates/:id", (req, res) => {
    const id = asInt(req.params.id);
    if (id === undefined) { res.status(400).json({ error: "id must be an integer" }); return; }
    const existing = db.getGuidanceTemplate(id);
    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }

    const b = req.body as UpdateBody;
    const patch: Parameters<MeshDb["updateGuidanceTemplate"]>[1] = {};

    if (b.name !== undefined) {
      const s = asString(b.name);
      if (!s) { res.status(400).json({ error: "name cannot be empty" }); return; }
      patch.name = s;
    }
    if (b.description !== undefined) {
      patch.description = typeof b.description === "string" ? b.description : "";
    }
    if (b.prompt_text !== undefined) {
      const s = asString(b.prompt_text);
      if (!s) { res.status(400).json({ error: "prompt_text cannot be empty" }); return; }
      patch.prompt_text = s;
    }
    if (b.schedule_config !== undefined) {
      const v = normalizeScheduleConfig(b.schedule_config);
      if (v === undefined) {
        res.status(400).json({ error: "schedule_config must be a JSON object or JSON string" });
        return;
      }
      patch.schedule_config = v;
    }
    if (b.sort_order !== undefined) {
      patch.sort_order = asInt(b.sort_order) ?? 0;
    }

    const tpl = db.updateGuidanceTemplate(id, patch);
    log.info(`Guidance template updated: #${id}`);
    res.json(tpl);
  });

  // ── 删 ───────────────────────────────────────────────────────────────────
  apiRouter.delete("/guidance-templates/:id", (req, res) => {
    const id = asInt(req.params.id);
    if (id === undefined) { res.status(400).json({ error: "id must be an integer" }); return; }
    const existing = db.getGuidanceTemplate(id);
    if (!existing) { res.status(404).json({ error: "Template not found" }); return; }
    if (existing.is_default === 1) {
      res.status(400).json({ error: "Cannot delete default template" });
      return;
    }
    db.deleteGuidanceTemplate(id);
    log.info(`Guidance template deleted: #${id}`);
    res.json({ ok: true });
  });
}
