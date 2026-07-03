/**
 * Digital Employee Mesh — Share / Visitor API
 *
 * Two surfaces:
 *
 *  1. Management (requires Bearer mesh_xxx):
 *     - POST   /api/groups/:groupId/shares    mint a visitor token for a group
 *     - DELETE /api/shares/:token              revoke a visitor token
 *
 *  2. Visitor read-only (token in URL, no Bearer). Path shape mirrors the
 *     existing Dashboard routes so the frontend can keep using its existing
 *     `groupsApi.getById(id)` etc. — the api client just prepends
 *     `/share/:token` to the path:
 *     - GET /api/share/:token/groups/:id                      group info + members
 *     - GET /api/share/:token/groups/:id/messages             group messages
 *     - GET /api/share/:token/groups/:groupId/issues          issues in the group
 *     - GET /api/share/:token/issues/:id                      one issue + events
 *     - GET /api/share/:token/issues/:id/messages             issue comments
 *     - GET /api/share/:token/issues/:id/events               issue event timeline
 *     - GET /api/share/:token/groups/:groupId/artifacts       artifact tree
 *     - GET /api/share/:token/groups/:groupId/artifacts/content  single file
 *     - GET /api/share/:token/groups/:groupId/notes           group notes
 *
 * Every visitor endpoint resolves the token via ShareTokenStore and 401s if
 * the token is unknown / revoked. Scope is implicit: a token is bound to one
 * groupId at mint time, so visitors cannot escape their group.
 */

import { type Router as ExpressRouter, type Request, type Response } from "express";
import fs from "node:fs";
import type { MeshDb } from "../db.js";
import type { ShareTokenStore } from "../share-tokens.js";
import { resolveGroupArtifactRoot } from "../group-paths.js";
import { createLogger } from "../../shared/logger.js";
import { readFileSafely, walkDir } from "../util/fs.js";

const log = createLogger("mesh-api");

interface AgentAuth { name: string; id: string }
type AuthedRequest = Request & { agentAuth?: AgentAuth }

function requireAgent(req: Request, res: Response): AgentAuth | null {
  const auth = (req as AuthedRequest).agentAuth;
  if (!auth) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return auth;
}

/** Resolve a share token; 401 if not found. Returns the resolved record. */
function requireToken(store: ShareTokenStore, token: string, res: Response) {
  const record = store.resolve(token);
  if (!record) {
    res.status(401).json({ error: "Invalid or expired share token" });
    return null;
  }
  return record;
}

export function registerShareRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  store: ShareTokenStore,
): void {
  // ── Management endpoints (require agent auth) ────────────────────────

  apiRouter.post("/groups/:groupId/shares", (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;

    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }

    const record = store.create(req.params.groupId, auth.name);
    log.info(`Share token minted for group ${req.params.groupId} by ${auth.name}`);
    res.status(201).json({
      token: record.token,
      groupId: record.groupId,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    });
  });

  apiRouter.delete("/shares/:token", (req, res) => {
    const auth = requireAgent(req, res);
    if (!auth) return;

    const record = store.resolve(req.params.token);
    if (!record) {
      // Idempotent: unknown tokens are already "gone", don't 404.
      res.json({ ok: true });
      return;
    }
    const removed = store.revoke(req.params.token);
    log.info(`Share token ${removed ? "revoked" : "not found"} by ${auth.name}`);
    res.json({ ok: true });
  });

  // ── Visitor read-only endpoints (token in URL) ───────────────────────

  apiRouter.get("/share/:token/groups", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    // Visitors can only see the single group their token grants scope to.
    const group = db.getGroupById(record.groupId);
    if (!group) {
      res.json([]);
      return;
    }
    const members = db.getGroupMembers(record.groupId);
    res.json([{ ...group, members }]);
  });

  // Visitors don't have their own agent list — return only the agents that are
  // members of the shared group, so the chat UI can resolve @mentions and
  // group member names without leaking agents from other groups.
  apiRouter.get("/share/:token/agents", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    const members = db.getGroupMembers(record.groupId);
    const memberNames = new Set(members.map((m) => m.agent_name));
    const scoped = db.listAgents().filter((a) => a.name && memberNames.has(a.name));
    res.json(scoped);
  });

  apiRouter.get("/share/:token/groups/:id", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    // Hard scope guard: a token only grants access to its bound group.
    if (req.params.id !== record.groupId) {
      res.status(403).json({ error: "Group not in shared scope" });
      return;
    }
    const group = db.getGroupById(record.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const members = db.getGroupMembers(record.groupId);
    res.json({ ...group, members });
  });

  apiRouter.get("/share/:token/groups/:id/messages", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    if (req.params.id !== record.groupId) {
      res.status(403).json({ error: "Group not in shared scope" });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(req.query, "limit")) {
      const total = Math.min(parseInt(req.query.limit as string) || 300, 500);
      res.json(db.getGroupMessages(record.groupId, 5, Math.max(total - 5, 0)));
    } else {
      res.json(db.getGroupMessages(record.groupId));
    }
  });

  apiRouter.get("/share/:token/groups/:groupId/issues", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    if (req.params.groupId !== record.groupId) {
      res.status(403).json({ error: "Group not in shared scope" });
      return;
    }
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    res.json(db.listIssuesByGroup(record.groupId, status, type));
  });

  apiRouter.get("/share/:token/issues/:id", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    // Hard scope guard: visitors can only see issues in their shared group.
    if (issue.group_id !== record.groupId) {
      res.status(403).json({ error: "Issue not in shared group" });
      return;
    }
    const events = db.getIssueEvents(req.params.id);
    res.json({ ...issue, events });
  });

  apiRouter.get("/share/:token/issues/:id/messages", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.group_id !== record.groupId) {
      res.status(403).json({ error: "Issue not in shared group" });
      return;
    }
    res.json(db.getIssueMessages(req.params.id));
  });

  apiRouter.get("/share/:token/issues/:id/events", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.group_id !== record.groupId) {
      res.status(403).json({ error: "Issue not in shared group" });
      return;
    }
    res.json(db.getIssueEvents(req.params.id));
  });

  apiRouter.get("/share/:token/groups/:groupId/notes", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    if (req.params.groupId !== record.groupId) {
      res.status(403).json({ error: "Group not in shared scope" });
      return;
    }
    res.json(db.listNotesByGroup(record.groupId));
  });

  // ── Visitor artifact endpoints ───────────────────────────────────────
  // Mirrors src/master/api/artifacts.ts but scoped to the visitor's group.
  // Path traversal guard and 500KB cap are kept identical.

  apiRouter.get("/share/:token/groups/:groupId/artifacts", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    if (req.params.groupId !== record.groupId) {
      res.status(403).json({ error: "Group not in shared scope" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, record.groupId);
    if (!fs.existsSync(groupDir)) {
      res.json({ root: groupDir, files: [] });
      return;
    }

    res.json({ root: groupDir, files: walkDir(groupDir, groupDir) });
  });

  apiRouter.get("/share/:token/groups/:groupId/artifacts/content", (req, res) => {
    const record = requireToken(store, req.params.token, res);
    if (!record) return;
    if (req.params.groupId !== record.groupId) {
      res.status(403).json({ error: "Group not in shared scope" });
      return;
    }
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, record.groupId);
    const result = readFileSafely(groupDir, filePath);
    if (result.kind === "outside-base") {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    if (result.kind === "missing") {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (result.kind === "too-large") {
      res.json({
        path: filePath,
        content: `[File too large: ${(result.size / 1024).toFixed(1)}KB]`,
        size: result.size,
        type: "text" as const,
      });
      return;
    }
    res.json({
      path: filePath,
      content: result.content,
      size: result.size,
      type: result.type,
    });
  });
}
