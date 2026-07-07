/**
 * Link 智能分类 REST —— 工具箱 Link 分类 tab 用。
 *
 * - GET  /api/links-patrol/state           — 当前 patrol-link 群 + scheduled_task 配置
 * - PATCH /api/links-patrol/config         — 改 enabled / intervalSec / scanBatch
 * - GET  /api/links-patrol/runs            — 最近 runs
 * - GET  /api/links-patrol/runs/:runId/logs — 单轮日志
 * - GET  /api/links-patrol/stats           — 采集 / 分类统计(总链接数 / 未分类数 / 分类 host 数)
 *
 * 仿 src/master/api/issues-patrol.ts(issue 巡检)的同名端点。type=patrol-link 群由建群时
 * 自动建,这里只读 + 改 schedule config + 看历史。
 */

import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api-links-patrol");

interface LinkPatrolPayload {
  patrolGroupId?: string;
  patrolAgentName?: string;
  scanBatch?: number;
}

function parsePayload(raw: string | null): LinkPatrolPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as LinkPatrolPayload;
  } catch {
    return {};
  }
}

function findLinkPatrolGroup(db: MeshDb): { groupId: string; groupName: string; agentName: string } | null {
  const groups = db.listGroupsByType("patrol-link").filter((g) => g.archived_at == null);
  if (groups.length === 0) return null;
  const group = groups[0];
  const task = db.listScheduledTasks({ groupId: group.id }).find((t) => t.handler_key === "link-patrol");
  const agentName = task?.agent_name ?? "";
  return { groupId: group.id, groupName: group.name, agentName };
}

export function registerLinkPatrolRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  // ── state ────────────────────────────────────────────────────────────────
  apiRouter.get("/links-patrol/state", (_req, res) => {
    const patrol = findLinkPatrolGroup(db);
    if (!patrol) {
      res.json({ enabled: false, hasPatrolGroup: false });
      return;
    }
    const task = db.listScheduledTasks({ groupId: patrol.groupId }).find((t) => t.handler_key === "link-patrol");
    if (!task) {
      res.json({
        hasPatrolGroup: true,
        patrolGroupId: patrol.groupId,
        patrolGroupName: patrol.groupName,
        patrolAgentName: patrol.agentName,
        enabled: false,
      });
      return;
    }
    const payload = parsePayload(task.handler_payload);
    res.json({
      hasPatrolGroup: true,
      patrolGroupId: patrol.groupId,
      patrolGroupName: patrol.groupName,
      patrolAgentName: patrol.agentName,
      taskId: task.id,
      enabled: task.enabled === 1,
      intervalSec: task.interval_sec,
      nextRunAt: task.next_run_at,
      lastRunAt: task.last_run_at,
      lastStatus: task.last_status,
      lastError: task.last_error,
      scanBatch: payload.scanBatch ?? 20,
    });
  });

  // ── config ────────────────────────────────────────────────────────────────
  apiRouter.patch("/links-patrol/config", (req, res) => {
    const patrol = findLinkPatrolGroup(db);
    if (!patrol) {
      res.status(400).json({ error: "未创建链接分类巡检群,请先建一个 type=patrol-link 的群" });
      return;
    }
    const task = db.listScheduledTasks({ groupId: patrol.groupId }).find((t) => t.handler_key === "link-patrol");
    if (!task) {
      res.status(404).json({ error: "链接分类定时任务不存在" });
      return;
    }

    const body = req.body ?? {};
    const patch: Parameters<MeshDb["updateScheduledTask"]>[1] = {};
    const payload = parsePayload(task.handler_payload);

    if (typeof body.enabled === "boolean") {
      patch.enabled = body.enabled;
    }
    if (typeof body.intervalSec === "number") {
      if (body.intervalSec < 60) {
        res.status(400).json({ error: "intervalSec 必须 >= 60" });
        return;
      }
      patch.intervalSec = Math.floor(body.intervalSec);
      patch.scheduleKind = "interval";
    }
    if (typeof body.scanBatch === "number") {
      if (body.scanBatch < 1 || body.scanBatch > 100) {
        res.status(400).json({ error: "scanBatch 取值 1-100" });
        return;
      }
      payload.scanBatch = Math.floor(body.scanBatch);
    }
    payload.patrolGroupId = payload.patrolGroupId ?? patrol.groupId;
    payload.patrolAgentName = payload.patrolAgentName ?? patrol.agentName;
    patch.handlerPayload = JSON.stringify(payload);

    const updated = db.updateScheduledTask(task.id, patch);
    if (!updated) {
      res.status(500).json({ error: "更新失败" });
      return;
    }
    log.info(`Link-patrol config updated (task #${task.id}): ${JSON.stringify(patch)}`);
    res.json({
      ok: true,
      enabled: updated.enabled === 1,
      intervalSec: updated.interval_sec,
      scanBatch: payload.scanBatch,
      nextRunAt: updated.next_run_at,
    });
  });

  // ── runs ──────────────────────────────────────────────────────────────────
  apiRouter.get("/links-patrol/runs", (req, res) => {
    const limit = parseLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const patrol = findLinkPatrolGroup(db);
    const [runs, total] = patrol
      ? [
          db.listLinkPatrolRuns({ patrolGroupId: patrol.groupId, limit, offset }),
          db.countLinkPatrolRuns({ patrolGroupId: patrol.groupId }),
        ]
      : [[], 0];
    res.json({ runs, total });
  });

  apiRouter.get("/links-patrol/runs/:runId/logs", (req, res) => {
    const logs = db.listLinkPatrolLogsForRun(req.params.runId);
    res.json({ logs });
  });

  // ── stats ─────────────────────────────────────────────────────────────────
  apiRouter.get("/links-patrol/stats", (_req, res) => {
    const totalRow = db.db.prepare("SELECT COUNT(*) as n FROM links").get() as { n: number };
    const unclassRow = db.db.prepare("SELECT COUNT(*) as n FROM links WHERE category IS NULL").get() as { n: number };
    const occRow = db.db.prepare("SELECT COUNT(*) as n FROM link_occurrences").get() as { n: number };
    const hostRow = db.db.prepare("SELECT COUNT(DISTINCT host) as n FROM links WHERE category IS NOT NULL").get() as { n: number };
    const patrol = findLinkPatrolGroup(db);
    const runs = patrol
      ? db.listLinkPatrolRuns({ patrolGroupId: patrol.groupId, limit: 1 })
      : [];
    const lastRun = runs[0] ?? null;
    res.json({
      totalLinks: totalRow.n,
      unclassified: unclassRow.n,
      totalOccurrences: occRow.n,
      classifiedHosts: hostRow.n,
      lastRun: lastRun
        ? {
            run_id: lastRun.run_id,
            started_at: lastRun.started_at,
            finished_at: lastRun.finished_at,
            status: lastRun.status,
            candidates_scanned: lastRun.candidates_scanned,
            candidates_classified: lastRun.candidates_classified,
            note: lastRun.note,
          }
        : null,
    });
  });
}

function parseLimit(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 200);
}

function parseOffset(v: unknown): number {
  const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
