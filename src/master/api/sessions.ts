/**
 * Session management API
 *
 * Surfaces the executor-side SessionStore (keyed `${cliTool}:${groupId}`)
 * to the dashboard. Every endpoint forwards a WS request to the right
 * worker(s) via WSHub.routeToExecutor and returns the first response.
 *
 * Endpoints:
 *   GET    /sessions?groupId=<id>
 *   GET    /sessions/:cliTool/:groupId/:sessionId?tail=<lines>
 *   DELETE /sessions/:cliTool/:groupId/:sessionId
 */

import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api-sessions");

/** Hex / uuid / dash-only sessionId — keeps URL paths from being abused. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** Known CLI backends; matches the switch in src/executor/index.ts. */
const SAFE_CLI = /^(claude|codex|hermes|openclaw)$/;

export function registerSessionRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  _auth: unknown,
  hub?: WSHub,
): void {
  if (!hub) {
    log.warn("[sessions] hub unavailable; routes registered as no-ops");
    return;
  }

  // ── List sessions for a group ──────────────────────────────────────────
  // Reads the master's in-memory `sessionSnapshots` cache (populated by
  // workers pushing `session_snapshot` after auth and after every
  // SessionStore mutation). No WS broadcast, no timeout — synchronous and
  // returns whatever workers have reported so far.
  //
  // Workers that have never connected since master start contribute nothing,
  // which matches the "live state" semantics the dashboard wants.
  apiRouter.get("/sessions", async (req, res) => {
    const groupId = typeof req.query.groupId === "string" ? req.query.groupId : "";
    if (!groupId) {
      res.status(400).json({ error: "groupId is required" });
      return;
    }
    if (!SAFE_ID.test(groupId)) {
      res.status(400).json({ error: "invalid groupId" });
      return;
    }
    const sessions = hub.listSessionsByGroup(groupId);
    res.json({ sessions });
  });

  // ── Session usage / model (latest issue for this cliTool+group) ──────────
  // Debug 视图 SessionPanel 用它把每个 session 的 token 用量 / 模型名从最近一次
  // 执行该 cliTool 的 issue 上拉出来。无需 worker 配合,纯查 DB。
  //
  // 不按 session_id 反查的原因:worker SessionStore 跟 issues.session_id 是两条
  // 独立路径(SessionStore 只在 chat/collab 路径更新,issue 执行不写),session_id
  // 经常对不上。改按 (cliTool, groupId) 取最新一条 issue 的 usage/model,展示
  // 「上次 claude/codex 在这个群里跑了多少 token」更贴近用户预期。
  apiRouter.get("/sessions/:cliTool/:groupId/:sessionId/usage", (req, res) => {
    const { cliTool, groupId, sessionId } = req.params;
    if (!SAFE_CLI.test(cliTool)) {
      res.status(400).json({ error: `invalid cliTool: ${cliTool}` });
      return;
    }
    if (!SAFE_ID.test(groupId) || !SAFE_ID.test(sessionId)) {
      res.status(400).json({ error: "invalid groupId or sessionId" });
      return;
    }
    void sessionId; // 校验通过即可,反查用 (cliTool, groupId) 不依赖 session_id
    const issue = db.getLatestIssueByCliTool(cliTool, groupId);
    if (!issue) {
      res.json({ cliTool, sessionId, usage: null, model: null, issueId: null });
      return;
    }
    let parsedUsage: unknown = null;
    if (issue.usage) {
      try { parsedUsage = JSON.parse(issue.usage); } catch { /* corrupted JSON, leave null */ }
    }
    res.json({
      cliTool,
      sessionId,
      usage: parsedUsage,
      model: issue.model ?? null,
      issueId: issue.id,
    });
  });

  // ── View session content ───────────────────────────────────────────────
  apiRouter.get("/sessions/:cliTool/:groupId/:sessionId", async (req, res) => {
    const { cliTool, groupId, sessionId } = req.params;
    if (!SAFE_CLI.test(cliTool)) {
      res.status(400).json({ error: `invalid cliTool: ${cliTool}` });
      return;
    }
    if (!SAFE_ID.test(groupId) || !SAFE_ID.test(sessionId)) {
      res.status(400).json({ error: "invalid groupId or sessionId" });
      return;
    }
    const tailLines = Math.min(
      Math.max(parseInt((req.query.tail as string) || "200", 10) || 200, 1),
      2000,
    );
    const requestId = randomUUID();
    try {
      const resp = await hub.routeToExecutor(
        (c) => c.cliTool === cliTool,
        { type: "session_view_request", requestId, groupId, sessionId, tailLines },
      );
      if (resp.type !== "session_view_response") {
        res.status(502).json({ error: "unexpected response from executor" });
        return;
      }
      res.json({
        cliTool,
        groupId,
        sessionId,
        format: resp.format,
        content: resp.content,
        error: resp.error,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      log.warn(`[sessions] view failed: ${msg}`);
      const code = /timeout/.test(msg) ? 504 : 502;
      res.status(code).json({ error: msg });
    }
  });

  // ── Delete a session ───────────────────────────────────────────────────
  // Worker is selected by cliTool (the worker that owns this session).
  // On success, the next chat / issue run for (cliTool, groupId) will
  // start a fresh session instead of --resume'ing the deleted one.
  apiRouter.delete("/sessions/:cliTool/:groupId/:sessionId", async (req, res) => {
    const { cliTool, groupId, sessionId } = req.params;
    if (!SAFE_CLI.test(cliTool)) {
      res.status(400).json({ error: `invalid cliTool: ${cliTool}` });
      return;
    }
    if (!SAFE_ID.test(groupId) || !SAFE_ID.test(sessionId)) {
      res.status(400).json({ error: "invalid groupId or sessionId" });
      return;
    }
    const requestId = randomUUID();
    try {
      const resp = await hub.routeToExecutor(
        (c) => c.cliTool === cliTool,
        { type: "session_delete_request", requestId, groupId, sessionId },
      );
      if (resp.type !== "session_delete_response") {
        res.status(502).json({ error: "unexpected response from executor" });
        return;
      }
      if (!resp.ok) {
        res.status(404).json({ error: resp.error || "session not found" });
        return;
      }
      log.info(`[sessions] deleted ${cliTool}:${groupId}:${sessionId}`);
      res.json({ ok: true });
    } catch (err: any) {
      const msg = err?.message || String(err);
      log.warn(`[sessions] delete failed: ${msg}`);
      const code = /timeout/.test(msg) ? 504 : 502;
      res.status(code).json({ error: msg });
    }
  });
}
