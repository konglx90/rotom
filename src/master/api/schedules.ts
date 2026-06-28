/**
 * /api/schedules — 群内定时任务 CRUD + trigger
 *
 * - 列表:GET /api/schedules?group_id=<id>
 * - 详情:GET /api/schedules/:id
 * - 新建:POST /api/schedules
 * - 改:   PATCH /api/schedules/:id(改 schedule 字段会重算 next_run_at)
 * - 删:   DELETE /api/schedules/:id
 * - 立刻触发:POST /api/schedules/:id/trigger
 *
 * 身份验证沿用 api/index.ts 的 permissive middleware(Dashboard cookie + agent Bearer 都允许)。
 */

import { type Router as ExpressRouter } from "express";
import type { MeshDb, ScheduledTaskRow } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api-schedules");

interface CreateBody {
  name?: unknown;
  group_id?: unknown;
  mode?: unknown;
  agent_name?: unknown;
  schedule_kind?: unknown;
  interval_sec?: unknown;
  run_at?: unknown;
  prompt?: unknown;
  repeat_times?: unknown;
  enabled?: unknown;
}

interface UpdateBody {
  name?: unknown;
  mode?: unknown;
  agent_name?: unknown;
  schedule_kind?: unknown;
  interval_sec?: unknown;
  run_at?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  repeat_times?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function asInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "1") return true;
  if (v === "false" || v === 0 || v === "0") return false;
  return undefined;
}

function asMode(v: unknown): "agent" | "message" | undefined {
  return v === "agent" || v === "message" ? v : undefined;
}

function asScheduleKind(v: unknown): "once" | "interval" | undefined {
  return v === "once" || v === "interval" ? v : undefined;
}

export function registerScheduleRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  // ── 列表 ─────────────────────────────────────────────────────────────────
  apiRouter.get("/schedules", (req, res) => {
    const groupId = asString(req.query.group_id);
    res.json(db.listScheduledTasks(groupId ? { groupId } : undefined));
  });

  // ── 详情 ─────────────────────────────────────────────────────────────────
  apiRouter.get("/schedules/:id", (req, res) => {
    const id = asInt(req.params.id);
    if (id === undefined) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }
    const task = db.getScheduledTask(id);
    if (!task) {
      res.status(404).json({ error: "Scheduled task not found" });
      return;
    }
    res.json(task);
  });

  // ── 新建 ─────────────────────────────────────────────────────────────────
  apiRouter.post("/schedules", (req, res) => {
    const b = req.body as CreateBody;
    const name = asString(b.name);
    const groupId = asString(b.group_id);
    const mode = asMode(b.mode);
    const scheduleKind = asScheduleKind(b.schedule_kind) ?? "interval";
    const prompt = asString(b.prompt);

    if (!name) { res.status(400).json({ error: "name is required" }); return; }
    if (!groupId) { res.status(400).json({ error: "group_id is required" }); return; }
    if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }
    if (!mode) { res.status(400).json({ error: "mode must be 'agent' or 'message'" }); return; }
    if (!db.getGroupById(groupId)) {
      res.status(404).json({ error: `Group not found: ${groupId}` });
      return;
    }

    let intervalSec: number | null = null;
    let runAt: number | null = null;
    if (scheduleKind === "interval") {
      intervalSec = asInt(b.interval_sec) ?? null;
      if (intervalSec === null || intervalSec < 30) {
        res.status(400).json({ error: "interval_sec must be an integer >= 30 for schedule_kind=interval" });
        return;
      }
    } else {
      runAt = asInt(b.run_at) ?? null;
      if (runAt === null || runAt <= Date.now()) {
        res.status(400).json({ error: "run_at must be a future epoch ms timestamp for schedule_kind=once" });
        return;
      }
    }

    let agentName: string | null = null;
    if (mode === "agent") {
      agentName = asString(b.agent_name) ?? null;
      if (!agentName) {
        res.status(400).json({ error: "agent_name is required for mode=agent" });
        return;
      }
    } else if (b.agent_name !== undefined) {
      // message 模式也允许带 agent_name,但存也无所谓 —— 这里忽略,保持 NULL
      agentName = asString(b.agent_name) ?? null;
    }

    const repeatTimes = b.repeat_times === null || b.repeat_times === undefined
      ? null
      : ((): number | null => {
          const n = asInt(b.repeat_times);
          return n !== undefined && n > 0 ? n : null;
        })();

    const enabled = asBool(b.enabled);
    const task = db.createScheduledTask({
      name,
      groupId,
      mode,
      agentName,
      scheduleKind,
      intervalSec,
      runAt,
      prompt,
      repeatTimes,
      enabled: enabled !== undefined ? enabled : true,
    });
    log.info(`Schedule created: #${task.id} "${task.name}" (${task.mode}/${task.schedule_kind}) in group ${groupId}`);
    res.status(201).json(task);
  });

  // ── 改 ───────────────────────────────────────────────────────────────────
  apiRouter.patch("/schedules/:id", (req, res) => {
    const id = asInt(req.params.id);
    if (id === undefined) { res.status(400).json({ error: "id must be an integer" }); return; }
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: "Scheduled task not found" }); return; }

    const b = req.body as UpdateBody;
    const patch: Parameters<MeshDb["updateScheduledTask"]>[1] = {};

    if (b.name !== undefined) {
      const s = asString(b.name);
      if (!s) { res.status(400).json({ error: "name cannot be empty" }); return; }
      patch.name = s;
    }
    if (b.mode !== undefined) {
      const m = asMode(b.mode);
      if (!m) { res.status(400).json({ error: "mode must be 'agent' or 'message'" }); return; }
      patch.mode = m;
    }
    if (b.agent_name !== undefined) {
      patch.agentName = asString(b.agent_name) ?? null;
    }
    if (b.prompt !== undefined) {
      const s = asString(b.prompt);
      if (!s) { res.status(400).json({ error: "prompt cannot be empty" }); return; }
      patch.prompt = s;
    }
    if (b.enabled !== undefined) {
      const v = asBool(b.enabled);
      if (v === undefined) { res.status(400).json({ error: "enabled must be boolean" }); return; }
      patch.enabled = v;
    }
    if (b.repeat_times !== undefined) {
      if (b.repeat_times === null) {
        patch.repeatTimes = null;
      } else {
        const n = asInt(b.repeat_times);
        if (n === undefined || n <= 0) {
          res.status(400).json({ error: "repeat_times must be a positive integer or null" });
          return;
        }
        patch.repeatTimes = n;
      }
    }

    // schedule 字段改动:三种字段互相影响,做一次合并校验
    const newKind = b.schedule_kind !== undefined ? asScheduleKind(b.schedule_kind) : existing.schedule_kind;
    const newInterval: number | undefined =
      b.interval_sec !== undefined ? asInt(b.interval_sec) : (existing.interval_sec ?? undefined);
    const newRunAt: number | undefined =
      b.run_at !== undefined ? asInt(b.run_at) : (existing.run_at ?? undefined);
    if (b.schedule_kind !== undefined && !newKind) {
      res.status(400).json({ error: "schedule_kind must be 'once' or 'interval'" });
      return;
    }
    if (newKind === "interval") {
      if (newInterval === undefined || newInterval < 30) {
        res.status(400).json({ error: "interval_sec must be an integer >= 30 for schedule_kind=interval" });
        return;
      }
      patch.scheduleKind = "interval";
      patch.intervalSec = newInterval;
    } else if (newKind === "once") {
      if (newRunAt === undefined || newRunAt <= Date.now()) {
        res.status(400).json({ error: "run_at must be a future epoch ms timestamp for schedule_kind=once" });
        return;
      }
      patch.scheduleKind = "once";
      patch.runAt = newRunAt;
    }

    const updated = db.updateScheduledTask(id, patch);
    if (!updated) {
      // shouldn't happen, we already checked existence
      res.status(404).json({ error: "Scheduled task not found" });
      return;
    }
    log.info(`Schedule #${id} updated`);
    res.json(updated);
  });

  // ── 删 ───────────────────────────────────────────────────────────────────
  apiRouter.delete("/schedules/:id", (req, res) => {
    const id = asInt(req.params.id);
    if (id === undefined) { res.status(400).json({ error: "id must be an integer" }); return; }
    const ok = db.deleteScheduledTask(id);
    if (!ok) { res.status(404).json({ error: "Scheduled task not found" }); return; }
    log.info(`Schedule #${id} deleted`);
    res.json({ ok: true });
  });

  // ── 立刻触发 ─────────────────────────────────────────────────────────────
  apiRouter.post("/schedules/:id/trigger", (req, res) => {
    const id = asInt(req.params.id);
    if (id === undefined) { res.status(400).json({ error: "id must be an integer" }); return; }
    const task = db.getScheduledTask(id);
    if (!task) { res.status(404).json({ error: "Scheduled task not found" }); return; }
    if (!task.enabled) {
      res.status(409).json({ error: "Scheduled task is disabled — re-enable it first" });
      return;
    }
    const ok = db.triggerScheduledTask(id);
    if (!ok) { res.status(409).json({ error: "Scheduled task is disabled" }); return; }
    log.info(`Schedule #${id} "${task.name}" manually triggered`);
    res.json({ ok: true, id, next_run_at: Date.now() });
  });
}