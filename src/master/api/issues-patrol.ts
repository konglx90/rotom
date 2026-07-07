/**
 * Issue 巡检 REST —— 工具箱 Issue 巡检 tab 用。
 *
 * - GET  /api/issues-patrol/state           — 当前 patrol 群 + 其 scheduled_task 配置
 * - PATCH /api/issues-patrol/config         — 改 enabled / intervalSec / 节流参数
 * - GET  /api/issues-patrol/runs            — 最近 runs
 * - GET  /api/issues-patrol/runs/:runId/logs — 单轮日志
 * - GET  /api/issues-patrol/logs            — 全局日志(可按 verdict / candidateGroupId 过滤)
 */

import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api-issues-patrol");

interface PatrolPayload {
  patrolGroupId?: string;
  patrolAgentName?: string;
  throughputCap?: number;
  candidateCap?: number;
  scanBatch?: number;
}

function parsePayload(raw: string | null): PatrolPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PatrolPayload;
  } catch {
    return {};
  }
}

function findPatrolGroup(db: MeshDb): { groupId: string; groupName: string; agentName: string } | null {
  const groups = db.listGroupsByType("patrol").filter((g) => g.archived_at == null);
  if (groups.length === 0) return null;
  const group = groups[0];
  const members = db.getGroupMembers(group.id);
  // patrol 群成员 = creator(人) + 巡检员(1 个 AI agent)。优先取 scheduled_task.agent_name,
  // 否则取第一个非空成员。
  const task = db.listScheduledTasks({ groupId: group.id }).find((t) => t.handler_key === "issue-patrol");
  const agentName = task?.agent_name ?? members[0]?.agent_name ?? "";
  return { groupId: group.id, groupName: group.name, agentName };
}

export function registerIssuePatrolRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  // ── state ────────────────────────────────────────────────────────────────
  apiRouter.get("/issues-patrol/state", (_req, res) => {
    const patrol = findPatrolGroup(db);
    if (!patrol) {
      res.json({ enabled: false, hasPatrolGroup: false });
      return;
    }
    const task = db.listScheduledTasks({ groupId: patrol.groupId }).find((t) => t.handler_key === "issue-patrol");
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
      throughputCap: payload.throughputCap ?? 3,
      candidateCap: payload.candidateCap ?? 3,
      scanBatch: payload.scanBatch ?? 10,
    });
  });

  // ── config ────────────────────────────────────────────────────────────────
  apiRouter.patch("/issues-patrol/config", (req, res) => {
    const patrol = findPatrolGroup(db);
    if (!patrol) {
      res.status(400).json({ error: "未创建巡检群,请先建一个 type=patrol 的群" });
      return;
    }
    const task = db.listScheduledTasks({ groupId: patrol.groupId }).find((t) => t.handler_key === "issue-patrol");
    if (!task) {
      res.status(404).json({ error: "巡检定时任务不存在" });
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
    if (typeof body.throughputCap === "number") {
      if (body.throughputCap < 1 || body.throughputCap > 20) {
        res.status(400).json({ error: "throughputCap 取值 1-20" });
        return;
      }
      payload.throughputCap = Math.floor(body.throughputCap);
    }
    if (typeof body.candidateCap === "number") {
      if (body.candidateCap < 1 || body.candidateCap > 20) {
        res.status(400).json({ error: "candidateCap 取值 1-20" });
        return;
      }
      payload.candidateCap = Math.floor(body.candidateCap);
    }
    if (typeof body.scanBatch === "number") {
      if (body.scanBatch < 1 || body.scanBatch > 50) {
        res.status(400).json({ error: "scanBatch 取值 1-50" });
        return;
      }
      payload.scanBatch = Math.floor(body.scanBatch);
    }
    // patrolGroupId / patrolAgentName 不可改,从原 payload 继承
    payload.patrolGroupId = payload.patrolGroupId ?? patrol.groupId;
    payload.patrolAgentName = payload.patrolAgentName ?? patrol.agentName;
    patch.handlerPayload = JSON.stringify(payload);

    const updated = db.updateScheduledTask(task.id, patch);
    if (!updated) {
      res.status(500).json({ error: "更新失败" });
      return;
    }
    log.info(`Patrol config updated (task #${task.id}): ${JSON.stringify(patch)}`);
    res.json({
      ok: true,
      enabled: updated.enabled === 1,
      intervalSec: updated.interval_sec,
      throughputCap: payload.throughputCap,
      candidateCap: payload.candidateCap,
      scanBatch: payload.scanBatch,
      nextRunAt: updated.next_run_at,
    });
  });

  // ── runs ──────────────────────────────────────────────────────────────────
  apiRouter.get("/issues-patrol/runs", (req, res) => {
    const limit = parseLimit(req.query.limit, 20);
    const offset = parseOffset(req.query.offset);
    const patrol = findPatrolGroup(db);
    const [runs, total] = patrol
      ? [
          db.listPatrolRuns({ patrolGroupId: patrol.groupId, limit, offset }),
          db.countPatrolRuns({ patrolGroupId: patrol.groupId }),
        ]
      : [[], 0];
    res.json({ runs, total });
  });

  apiRouter.get("/issues-patrol/runs/:runId/logs", (req, res) => {
    const logs = db.listPatrolLogsForRun(req.params.runId);
    res.json({ logs });
  });

  // ── logs ──────────────────────────────────────────────────────────────────
  apiRouter.get("/issues-patrol/logs", (req, res) => {
    const limit = parseLimit(req.query.limit, 200);
    const verdict = typeof req.query.verdict === "string" ? req.query.verdict : undefined;
    const candidateGroupId = typeof req.query.candidateGroupId === "string" ? req.query.candidateGroupId : undefined;
    const patrol = findPatrolGroup(db);
    const logs = db.listPatrolLogs({
      patrolGroupId: patrol?.groupId,
      verdict: verdict as any,
      candidateGroupId,
      limit,
    });
    res.json({ logs });
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
