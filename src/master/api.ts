/**
 * Digital Employee Mesh — REST API
 *
 * Dashboard endpoints are open (no login). Agent-token endpoints expect a
 * `Bearer mesh_xxx` header and reject anonymous calls inline.
 */

import { Router as ExpressRouter, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { MeshDb, AgentRow } from "./db.js";
import { AuthService, hashToken } from "./auth.js";
import type { WSHub } from "./ws-hub.js";
import type { Router } from "./router.js";
import type { AgentProfile } from "../shared/protocol.js";
import { defaultGroupWorkingDir, resolveGroupArtifactRoot } from "./group-paths.js";

import { createLogger } from "../shared/logger.js";
import { parseSlashCommand } from "../shared/slash-commands.js";

const log = createLogger("mesh-api");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Idempotent recursive mkdir; throws on permission errors. */
function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Return the first non-loopback IPv4 address, or "localhost" as fallback. */
function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

// ---------------------------------------------------------------------------
// Create API router
// ---------------------------------------------------------------------------

export function createApi(db: MeshDb, sharedAuth?: AuthService, hub?: WSHub, router?: Router, serverPort?: number): ExpressRouter {
  const apiRouter = ExpressRouter();
  const auth = sharedAuth ?? new AuthService(db);

  // ── Request logging middleware ──────────────────────────────────────────
  apiRouter.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  // ── Permissive auth middleware ──────────────────────────────────────────
  // Dashboard endpoints are open. mesh_* bearer tokens are still resolved so
  // routes that need an authenticated agent (whoami / send-as-me) can read
  // `req.agentAuth`. Unknown / missing headers pass through — agent-only
  // routes reject anonymous callers inline.
  apiRouter.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(200).end();
      return;
    }

    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      const token = header.slice(7);
      if (token.startsWith("mesh_")) {
        const agent = db.getAgentByTokenHash(hashToken(token));
        if (agent) {
          (req as any).agentAuth = { name: agent.name, id: agent.id };
        }
      }
    }
    next();
  });

  // ── Agent list ──────────────────────────────────────────────────────────
  apiRouter.get("/agents", (_req, res) => {
    const agents = db.listAgents();
    const statsByName = new Map<string, Record<string, unknown>>();
    for (const row of db.agentMessageStats()) {
      const name = row.name as string;
      if (name) statsByName.set(name, row);
    }
    const safe = agents.map((a: AgentRow) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      domain: a.domain,
      status: a.status,
      hostname: a.hostname,
      endpoint: a.endpoint,
      enabled: a.enabled !== 0,
      lastHeartbeat: a.last_heartbeat,
      connectedAt: a.connected_at,
      registeredAt: a.registered_at,
      profile: parseProfile(a.profile),
      message_stats: (() => {
        const s = statsByName.get(a.name);
        if (!s) return undefined;
        return {
          sent: Number(s.sent) || 0,
          received: Number(s.received) || 0,
          replied: Number(s.replied) || 0,
          failed: Number(s.failed) || 0,
          avg_latency_ms: s.avg_latency_ms == null ? 0 : Number(s.avg_latency_ms),
        };
      })(),
    }));
    res.json(safe);
  });

  apiRouter.get("/agents/online", (_req, res) => {
    const agents = db.listAgents({ status: "online" });
    const safe = agents.map((a: AgentRow) => ({
      name: a.name,
      domain: a.domain,
      status: a.status,
    }));
    res.json(safe);
  });

  // ── Register agent ──────────────────────────────────────────────────────
  apiRouter.post("/agents", (req, res) => {
    const { name, description, domain, profile } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Domain is required — strict domain model
    if (!domain || typeof domain !== "string") {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    // Validate domain exists
    const domainRow = db.getDomainByName(domain);
    if (!domainRow) {
      res.status(400).json({ error: `Domain "${domain}" does not exist. Create it first.` });
      return;
    }

    const existing = db.getAgentByName(name);
    if (existing) {
      res.status(409).json({ error: `Agent "${name}" already exists` });
      return;
    }

    const id = randomUUID();
    const token = auth.generateToken();

    db.insertAgent({
      id,
      name,
      description,
      domain,
      tokenHash: hashToken(token),
      token,
      profile: profile && typeof profile === "object" ? JSON.stringify(profile) : undefined,
    });

    log.info(`Agent registered: "${name}" (domain=${domain})`);

    // Dynamic config template — prefer LAN IP so agents on other machines can connect
    const port = serverPort ?? 18800;
    const ip = getLocalIp();
    const masterProto = req.secure ? "wss" : "ws";

    res.status(201).json({
      id,
      name,
      token,
      configTemplate: {
        channels: {
          "a2a-gateway": {
            master: `${masterProto}://${ip}:${port}`,
            name,
            token,
          },
        },
      },
      guide: [
        "1. 复制上方 channels 配置到 openclaw.json",
        "2. 启动 OpenClaw Gateway",
        "3. 节点将自动连接 Master",
      ],
    });
  });

  // ── Agent detail ─────────────────────────────────────────────────────────
  apiRouter.get("/agents/:id", (req, res) => {
    const agent = db.getAgentById(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      domain: agent.domain,
      status: agent.status,
      hostname: agent.hostname,
      instanceId: agent.instance_id,
      platform: agent.platform,
      endpoint: agent.endpoint,
      enabled: agent.enabled !== 0,
      lastHeartbeat: agent.last_heartbeat,
      connectedAt: agent.connected_at,
      registeredAt: agent.registered_at,
      profile: parseProfile(agent.profile),
      // Plaintext mesh_* token. NULL for agents registered before migration 016
      // (those need a refresh-token to get a fresh plaintext).
      token: agent.token,
    });
  });

  // ── Refresh token ───────────────────────────────────────────────────────
  apiRouter.post("/agents/:id/refresh-token", (req, res) => {
    const agent = db.getAgentById(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const newToken = auth.generateToken();
    db.updateAgentToken(agent.id, hashToken(newToken), newToken);
    log.warn(`Token refreshed for agent "${agent.name}" (id=${agent.id})`);
    res.json({ token: newToken });
  });

  // ── Update agent ────────────────────────────────────────────────────────
  apiRouter.put("/agents/:id", (req, res) => {
    const agent = db.getAgentById(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const { name, description, domain, enabled, profile } = req.body;
    // Validate name if being changed
    if (name !== undefined) {
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "name cannot be empty" });
        return;
      }
      const existing = db.getAgentByName(name.trim());
      if (existing && existing.id !== agent.id) {
        res.status(409).json({ error: `Name "${name}" is already taken` });
        return;
      }
      db.updateAgentName(agent.id, name.trim());
    }
    // Validate domain if being changed
    if (domain !== undefined) {
      if (!domain || typeof domain !== "string") {
        res.status(400).json({ error: "domain cannot be empty" });
        return;
      }
      const domainRow = db.getDomainByName(domain);
      if (!domainRow) {
        res.status(400).json({ error: `Domain "${domain}" does not exist` });
        return;
      }
    }
    if (description !== undefined || domain !== undefined || profile !== undefined) {
      db.updateAgentMeta(agent.id, {
        description,
        domain,
        profile: profile !== undefined ? JSON.stringify(profile) : undefined,
      });
    }
    if (enabled !== undefined) {
      db.updateAgentEnabled(agent.id, !!enabled);
    }

    // Push changes to connected agents via WebSocket
    if (hub) {
      // Notify the target agent of master-owned config changes
      if (domain !== undefined || enabled !== undefined) {
        hub.pushConfigUpdate(agent.id, {
          domain: domain ?? agent.domain ?? undefined,
          enabled: enabled !== undefined ? !!enabled : agent.enabled !== 0,
        });
      }
      // Broadcast directory update to all agents
      hub.broadcastAgentUpdate(agent.id);
    }

    res.json({ ok: true });
  });

  // ── Delete agent ────────────────────────────────────────────────────────
  apiRouter.delete("/agents/:id", (req, res) => {
    const agent = db.getAgentById(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    if (agent.status === "online") {
      res.status(400).json({ error: "Cannot delete an online agent. Disconnect it first." });
      return;
    }
    db.deleteAgent(agent.id);
    log.warn(`Agent deleted: "${agent.name}" (id=${agent.id})`);
    res.json({ ok: true });
  });

  // ── Domains ─────────────────────────────────────────────────────────────
  apiRouter.get("/domains", (_req, res) => {
    const domains = db.listDomains();
    // Enrich with agent count per domain
    const enriched = domains.map(d => ({
      ...d,
      agentCount: db.countAgentsByDomain(d.name),
    }));
    res.json(enriched);
  });

  apiRouter.post("/domains", (req, res) => {
    const { name, description } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const trimmed = name.trim();
    const existing = db.getDomainByName(trimmed);
    if (existing) {
      res.status(409).json({ error: `Domain "${trimmed}" already exists` });
      return;
    }
    const id = randomUUID();
    db.insertDomain(id, trimmed, description);
    res.status(201).json({ id, name: trimmed, description: description || null });
  });

  apiRouter.put("/domains/:id", (req, res) => {
    const domain = db.getDomainById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    const { name, description } = req.body;
    // If renaming, check uniqueness and update agents
    if (name !== undefined && name !== domain.name) {
      const dup = db.getDomainByName(name);
      if (dup) {
        res.status(409).json({ error: `Domain "${name}" already exists` });
        return;
      }
      // Update all agents in the old domain to the new name
      db.renameDomainInAgents(domain.name, name);
    }
    db.updateDomain(domain.id, { name, description });
    res.json({ ok: true });
  });

  apiRouter.delete("/domains/:id", (req, res) => {
    const domain = db.getDomainById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    const count = db.countAgentsByDomain(domain.name);
    if (count > 0) {
      res.status(400).json({ error: `域「${domain.name}」仍有 ${count} 个员工，请先移走。` });
      return;
    }
    const ruleCount = db.countCrossDomainRulesByDomain(domain.name);
    if (ruleCount > 0) {
      res.status(400).json({ error: `域「${domain.name}」仍有 ${ruleCount} 条跨域规则，请先删除。` });
      return;
    }
    db.deleteDomain(domain.id);
    res.json({ ok: true });
  });

  // ── Audit log ───────────────────────────────────────────────────────────
  apiRouter.get("/audit", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    res.json(db.listAudit(limit));
  });

  // ── Stats ───────────────────────────────────────────────────────────────
  apiRouter.get("/stats", (_req, res) => {
    const basic = db.stats();
    const msgStats = db.agentMessageStats();
    res.json({ ...basic, agents: msgStats });
  });

  // ── Message log ─────────────────────────────────────────────────────────
  apiRouter.get("/messages", (req, res) => {
    const agent = req.query.agent as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const status = req.query.status as string | undefined;
    const keyword = req.query.keyword as string | undefined;
    const groupId = req.query.groupId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const before = req.query.before as string | undefined;
    const messages = db.listMessages({ agent, from, to, status, keyword, groupId, limit, offset, before });
    const total = db.countMessages({ agent, from, to, status, keyword, groupId, before });
    res.json({ messages, total });
  });

  // ── Send message to agent ───────────────────────────────────────────────
  apiRouter.post("/messages/send", (req, res) => {
    const { from, to, message } = req.body;

    if (!from || !to || !message) {
      res.status(400).json({ error: "from, to, and message are required" });
      return;
    }

    // Get sender agent info
    const fromAgent = db.getAgentByName(from);
    if (!fromAgent) {
      res.status(404).json({ error: `Sender agent "${from}" not found` });
      return;
    }

    // Get target agent info
    const toAgent = db.getAgentByName(to);
    if (!toAgent) {
      res.status(404).json({ error: `Target agent "${to}" not found` });
      return;
    }

    // Generate request ID
    const requestId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Route message using the message router
    if (!router) {
      res.status(500).json({ error: "Message router not available" });
      return;
    }

    const routeResult = router.route(fromAgent.id as string, {
      requestId,
      target: to,
      payload: { message }
    });

    if (routeResult.error) {
      res.status(500).json({ error: routeResult.error });
      return;
    }

    // Send via WebSocket if hub is available
    let delivered = false;
    let queued = false;

    if (routeResult.targetAgentId && hub) {
      delivered = hub.sendToAgent(routeResult.targetAgentId, {
        type: "a2a_message",
        requestId,
        from: { name: from, domain: fromAgent.domain || undefined, status: "online" },
        payload: { message },
        routeType: "exact",
      });

      if (!delivered) {
        // Target agent is offline, queue the message
        queued = true;
      }
    }

    // Log message
    db.logMessage({
      requestId,
      fromName: from,
      fromDomain: fromAgent.domain || undefined,
      toName: to,
      toDomain: toAgent.domain || undefined,
      routeType: "exact",
      direction: "send",
      payload: JSON.stringify({ message }),
      status: routeResult.error ? "failed" : queued ? "queued" : delivered ? "delivered" : "failed",
      source: "api",
    });

    res.json({
      requestId,
      delivered,
      queued,
      message: "Message sent successfully"
    });
  });

  // ── CLI / agent-token-authed endpoints ─────────────────────────────────
  // These use the caller's mesh token to derive `from`, so callers do not
  // need to know (or be allowed to spoof) sender names.

  /** Whoami — echo back the caller's identity derived from the auth token. */
  apiRouter.get("/whoami", (req, res) => {
    const agentAuth = (req as any).agentAuth as { name: string; id: string } | undefined;
    if (agentAuth) {
      const agent = db.getAgentById(agentAuth.id);
      res.json({ kind: "agent", name: agentAuth.name, id: agentAuth.id, domain: agent?.domain || null });
      return;
    }
    res.json({ kind: "dashboard" });
  });

  /** Send a group message as the authed agent (target must be a group member). */
  apiRouter.post("/cli/groups/:groupId/send", (req, res) => {
    const agentAuth = (req as any).agentAuth as { name: string } | undefined;
    if (!agentAuth) {
      res.status(403).json({ error: "Mesh token required (use a Bearer mesh_xxx token)" });
      return;
    }
    if (!hub) { res.status(500).json({ error: "WSHub not available" }); return; }
    const group = db.getGroupById(req.params.groupId);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot send messages" }); return; }
    const { target, message } = req.body || {};
    if (!target || !message) { res.status(400).json({ error: "target and message are required" }); return; }
    const r = hub.sendAsAgent({
      fromName: agentAuth.name,
      target,
      message,
      groupId: req.params.groupId,
      groupName: group.name,
    });
    if (r.error) { res.status(400).json(r); return; }
    res.json(r);
  });

  // ── Cross-domain rules ─────────────────────────────────────────────────
  apiRouter.get("/cross-domain", (_req, res) => {
    const rules = db.listCrossDomainRules();
    // Domains from domains table (not from agents — strict domain model)
    const domains = db.listDomains().map(d => d.name);
    res.json({ rules, domains });
  });

  apiRouter.post("/cross-domain", (req, res) => {
    const { from, to, bidirectional } = req.body;
    if (!from || !to) {
      res.status(400).json({ error: "from and to required" });
      return;
    }
    if (from === to) {
      res.status(400).json({ error: "from and to must be different" });
      return;
    }
    try {
      db.addCrossDomainRule(from, to, bidirectional === true);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(409).json({ error: e.message });
    }
  });

  apiRouter.delete("/cross-domain", (req, res) => {
    const { from, to } = req.body;
    if (!from || !to) {
      res.status(400).json({ error: "from and to required" });
      return;
    }
    const deleted = db.deleteCrossDomainRule(from, to);
    res.json({ ok: true, deleted });
  });

  // ── Groups ───────────────────────────────────────────────────────────────

  // One-time backfill: legacy groups created before the per-group default cwd
  // landed have `working_dir = NULL`. Fill them with the absolute default and
  // mkdir each so executors can spawn into them without ENOENT.
  {
    const filled = db.backfillGroupDefaultWorkingDir(defaultGroupWorkingDir);
    for (const { workingDir } of filled) {
      try { ensureDir(workingDir); }
      catch (err: any) {
        log.warn(`Backfill mkdir failed for ${workingDir}: ${err?.code ?? err?.message ?? err}`);
      }
    }
    if (filled.length > 0) {
      log.info(`Backfilled working_dir for ${filled.length} legacy group(s)`);
    }
  }

  // Normalize and validate a user-provided working directory path. Expands a
  // leading `~`/`~/...`, resolves to absolute, and verifies the directory
  // exists and is readable. Returns the canonical absolute path on success,
  // or an `error` string describing why it was rejected.
  //
  // `null` / empty input means "clear / no working dir" — caller decides
  // whether that's allowed; this helper only validates non-empty input.
  function validateWorkingDir(input: unknown): { ok: true; path: string } | { ok: false; error: string } {
    if (typeof input !== "string") return { ok: false, error: "working_dir must be a string" };
    const raw = input.trim();
    if (!raw) return { ok: false, error: "working_dir is empty" };

    let expanded = raw;
    if (raw === "~") expanded = os.homedir();
    else if (raw.startsWith("~/")) expanded = path.join(os.homedir(), raw.slice(2));

    if (!path.isAbsolute(expanded)) {
      return { ok: false, error: `working_dir must be an absolute path (got: ${raw})` };
    }
    const resolved = path.resolve(expanded);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch (err: any) {
      if (err?.code === "ENOENT") return { ok: false, error: `工作目录不存在: ${resolved}` };
      return { ok: false, error: `工作目录无法访问: ${resolved} (${err?.code ?? err?.message ?? "unknown"})` };
    }
    if (!stat.isDirectory()) {
      return { ok: false, error: `工作目录不是一个目录: ${resolved}` };
    }
    try {
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      return { ok: false, error: `工作目录无读取/进入权限: ${resolved}` };
    }
    return { ok: true, path: resolved };
  }

  apiRouter.get("/groups", (_req, res) => {
    res.json(db.listGroupsWithMembers());
  });

  apiRouter.post("/groups", (req, res) => {
    const { name, memberNames, workingDir } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const id = randomUUID();
    let workDir: string;
    if (typeof workingDir === "string" && workingDir.trim()) {
      const v = validateWorkingDir(workingDir);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      workDir = v.path;
    } else {
      // Default cwd: per-group dir under RESULTS_ROOT. Persisting as absolute
      // path keeps `~` out of the DB and aligns agent cwd with the artifacts
      // panel (which already reads from ~/.rotom/results/<groupId>).
      workDir = defaultGroupWorkingDir(id);
      try {
        ensureDir(workDir);
      } catch (err: any) {
        res.status(500).json({ error: `创建默认工作目录失败: ${workDir} (${err?.code ?? err?.message ?? "unknown"})` });
        return;
      }
    }
    db.createGroup(id, name.trim(), undefined, workDir);
    if (Array.isArray(memberNames) && memberNames.length > 0) {
      db.addGroupMembers(id, memberNames);
    }
    log.info(`Group created: "${name.trim()}" (${id}) cwd=${workDir}`);
    res.status(201).json({ id, name: name.trim(), working_dir: workDir, memberCount: Array.isArray(memberNames) ? memberNames.length : 0 });
  });

  apiRouter.patch("/groups/:id", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const { name, workingDir, pinned } = req.body;
    if (name !== undefined && name !== null) {
      db.updateGroupName(req.params.id, String(name));
      log.info(`Group ${req.params.id} name → ${name}`);
    }
    if (workingDir === undefined && name === undefined && pinned === undefined && archived === undefined) {
      res.status(400).json({ error: "no updatable fields" });
      return;
    }
    if (pinned !== undefined) {
      const next = db.updateGroupPinned(req.params.id, Boolean(pinned));
      log.info(`Group ${req.params.id} pinned_at → ${next ?? "null"}`);
    }
    if (archived !== undefined) {
      const next = db.updateGroupArchived(req.params.id, Boolean(archived));
      log.info(`Group ${req.params.id} archived_at → ${next ?? "null"}`);
    }
    if (workingDir !== undefined) {
      let next: string;
      if (typeof workingDir === "string" && workingDir.trim()) {
        const v = validateWorkingDir(workingDir);
        if (!v.ok) {
          res.status(400).json({ error: v.error });
          return;
        }
        next = v.path;
      } else {
        // Empty / null → reset to the per-group default rather than clearing,
        // so every group always has a concrete cwd.
        next = defaultGroupWorkingDir(req.params.id);
        try {
          ensureDir(next);
        } catch (err: any) {
          res.status(500).json({ error: `创建默认工作目录失败: ${next} (${err?.code ?? err?.message ?? "unknown"})` });
          return;
        }
      }
      db.updateGroupWorkingDir(req.params.id, next);
      log.info(`Group ${req.params.id} working_dir → ${next}`);
    }
    res.json({ ok: true });
  });

  apiRouter.get("/groups/:id", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const members = db.getGroupMembers(req.params.id);
    res.json({ ...group, members });
  });

  apiRouter.delete("/groups/:id", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    db.deleteGroup(req.params.id);
    log.info(`Group deleted: "${group.name}" (${req.params.id})`);
    res.json({ ok: true });
  });

  apiRouter.post("/groups/:id/members", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot modify members" }); return; }
    const { agentNames } = req.body;
    if (!Array.isArray(agentNames) || agentNames.length === 0) {
      res.status(400).json({ error: "agentNames array is required" });
      return;
    }
    db.addGroupMembers(req.params.id, agentNames);
    res.json({ ok: true });
  });

  apiRouter.delete("/groups/:id/members", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot modify members" }); return; }
    const { agentNames } = req.body;
    if (!Array.isArray(agentNames) || agentNames.length === 0) {
      res.status(400).json({ error: "agentNames array is required" });
      return;
    }
    db.removeGroupMembers(req.params.id, agentNames);
    res.json({ ok: true });
  });

  apiRouter.get("/groups/:id/messages", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    res.json(db.getGroupMessages(req.params.id, limit));
  });

  apiRouter.post("/groups/:id/messages", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot send messages" }); return; }
    const { sender, content, mentions } = req.body;
    if (!sender || !content) {
      res.status(400).json({ error: "sender and content are required" });
      return;
    }
    db.addGroupMessage(req.params.id, sender, content, Array.isArray(mentions) ? mentions : []);

    // Also log to message_log so group messages appear in the dashboard
    db.logMessage({
      requestId: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      fromName: sender,
      direction: "send",
      payload: JSON.stringify({ message: content, mentions: Array.isArray(mentions) ? mentions : [], groupName: group.name }),
      status: "group_message",
      groupId: group.id,
      source: "api",
    });

    // Auto-detect [ISSUE] markers in group messages and create issues
    const issueMatch = content.match(/\[ISSUE\]\s*(.+?)(?:\n([\s\S]*))?$/);
    if (issueMatch) {
      const issueId = randomUUID();
      const issueTitle = issueMatch[1].trim();
      const issueDesc = issueMatch[2]?.trim() || "";
      db.createIssue({
        id: issueId,
        groupId: req.params.id,
        title: issueTitle,
        description: issueDesc,
        createdBy: sender,
      });
      log.info(`Issue auto-created from message: "${issueTitle}" (${issueId})`);
      if (hub) {
        hub.notifyIssueChanged(issueId, req.params.id, "created");
      }
    }

    res.status(201).json({ ok: true });
  });

  // ── Issues (task tracking) ─────────────────────────────────────────────

  // Global issue list across all groups (read-only kanban view)
  apiRouter.get("/issues", (req, res) => {
    const status = req.query.status as string | undefined;
    res.json(db.listAllIssues(status));
  });

  // List issues for a group
  apiRouter.get("/groups/:groupId/issues", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    res.json(db.listIssuesByGroup(req.params.groupId, status, type));
  });

  // Create issue
  apiRouter.post("/groups/:groupId/issues", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot create issues" }); return; }
    const { title, description, priority, createdBy, workingDir, approvalPolicy } = req.body;
    if (!title || !createdBy) {
      res.status(400).json({ error: "title and createdBy are required" });
      return;
    }
    let normalizedApprovalPolicy: "r_allow" | "rw_allow" | undefined;
    if (approvalPolicy !== undefined) {
      if (approvalPolicy !== "r_allow" && approvalPolicy !== "rw_allow") {
        res.status(400).json({ error: "approvalPolicy must be 'r_allow' or 'rw_allow'" });
        return;
      }
      normalizedApprovalPolicy = approvalPolicy;
    }
    let issueWorkDir: string | undefined;
    if (typeof workingDir === "string" && workingDir.trim()) {
      const v = validateWorkingDir(workingDir);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      issueWorkDir = v.path;
    } else if (group.working_dir) {
      // 没传 workingDir 时，默认用群的工作目录
      issueWorkDir = group.working_dir;
    }
    // Slash command 解析：title 形如 "/plan ..."。命中已注册命令则持久化到
    // issues.slash_command，worker 据此向底层 CLI 注入对应执行模式。
    // 未登记的前缀（含拼写错误）当作普通文案，避免误伤"/path"等内容。
    let slashCommand: string | undefined;
    const parsed = parseSlashCommand(title);
    if (parsed?.known) {
      if (!parsed.stripped) {
        res.status(400).json({ error: `Slash command "${parsed.command}" 后必须跟任务正文` });
        return;
      }
      slashCommand = parsed.command;
    }
    const id = randomUUID();
    db.createIssue({
      id, groupId: req.params.groupId, title, description,
      priority, createdBy, workingDir: issueWorkDir, slashCommand,
      approvalPolicy: normalizedApprovalPolicy,
    });
    log.info(`Issue created: "${title}" (${id}) in group ${req.params.groupId}`);
    if (hub) {
      hub.notifyIssueChanged(id, req.params.groupId, "created");
    }
    res.status(201).json({ id, title, status: "open" });
  });

  // Get issue detail with events
  apiRouter.get("/issues/:id", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const events = db.getIssueEvents(req.params.id);
    res.json({ ...issue, events });
  });

  // Update issue (assign, change priority)
  apiRouter.put("/issues/:id", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const { assignedTo, priority, title, description, approvalPolicy } = req.body;
    if (assignedTo !== undefined) {
      // null/"" means "unassign" — clear the field, don't push assignment.
      const normalized = (assignedTo === null || assignedTo === "") ? null : String(assignedTo);
      db.updateIssueStatus(req.params.id, issue.status, { assignedTo: normalized });
      db.addIssueEvent({
        issueId: req.params.id, eventType: "assigned",
        agentName: normalized || "system",
        content: normalized ? `Assigned to ${normalized}` : `Unassigned`,
      });
      // 注:指派本身不再触发 worker 执行。用户需在 dashboard 上点「开始任务」
      // (走 /issues/:id/append) 才会让 worker 跑起来。这是为了支持「先指派、
      // 检查 prompt、再开始执行」的工作流;以前指派即执行的语义被有意收回。
    }
    if (priority !== undefined) {
      db.updateIssuePriority(req.params.id, priority);
    }
    // 手动编辑 title / description。标题不能清空,描述允许为空字符串。
    if (title !== undefined || description !== undefined) {
      const fields: { title?: string; description?: string; slashCommand?: string | null } = {};
      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) {
          res.status(400).json({ error: "title cannot be empty" });
          return;
        }
        fields.title = t;
        // 同步 slash_command：编辑后的 title 重新解析，已注册命中则记录，否则清空。
        const parsed = parseSlashCommand(t);
        if (parsed?.known) {
          if (!parsed.stripped) {
            res.status(400).json({ error: `Slash command "${parsed.command}" 后必须跟任务正文` });
            return;
          }
          fields.slashCommand = parsed.command;
        } else {
          fields.slashCommand = null;
        }
      }
      if (description !== undefined) {
        fields.description = description === null ? "" : String(description);
      }
      db.updateIssueContent(req.params.id, fields);
      const changedLabels = [
        fields.title !== undefined ? "标题" : null,
        fields.description !== undefined ? "描述" : null,
      ].filter(Boolean).join("、");
      db.addIssueEvent({
        issueId: req.params.id, eventType: "edited",
        agentName: "system",
        content: `手动编辑 ${changedLabels}`,
      });
    }
    if (approvalPolicy !== undefined) {
      if (approvalPolicy !== "r_allow" && approvalPolicy !== "rw_allow") {
        res.status(400).json({ error: "approvalPolicy must be 'r_allow' or 'rw_allow'" });
        return;
      }
      if (approvalPolicy !== issue.approval_policy) {
        db.updateIssueContent(req.params.id, { approvalPolicy });
        db.addIssueEvent({
          issueId: req.params.id, eventType: "edited",
          agentName: "system",
          content: `审批策略改为 ${approvalPolicy === "rw_allow" ? "读写默认通过" : "读默认通过"}`,
        });
      }
    }
    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    res.json({ ok: true });
  });

  // Cancel issue
  apiRouter.post("/issues/:id/cancel", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.status === "completed" || issue.status === "failed" || issue.status === "cancelled") {
      res.status(400).json({ error: `Cannot cancel an issue in status "${issue.status}"` });
      return;
    }
    const cancelledBy = req.body.cancelledBy || "system";
    const wasInProgress = issue.status === "in_progress";
    db.updateIssueStatus(req.params.id, "cancelled");
    db.addIssueEvent({
      issueId: req.params.id, eventType: "cancelled",
      agentName: cancelledBy,
    });

    // If an executor was running this issue, tell it to abort the CLI process.
    if (hub && wasInProgress && issue.assigned_to) {
      const agent = db.getAgentByName(issue.assigned_to);
      if (agent) {
        const delivered = hub.sendToAgent(agent.id, {
          type: "issue_cancelled",
          issueId: req.params.id,
          groupId: issue.group_id,
          reason: `cancelled by ${cancelledBy}`,
        });
        log.info(`Issue ${req.params.id} cancel → ${issue.assigned_to}: sent=${delivered}`);
      } else {
        log.warn(`Issue ${req.params.id} assigned to "${issue.assigned_to}" but agent not registered`);
      }
    }

    // Public system announcement in the group (if any).
    if (hub && issue.group_id) {
      hub.postSystemToGroup(issue.group_id, `🚫 Issue 「${issue.title}」已被 ${cancelledBy} 取消`);
    }

    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    res.json({ ok: true });
  });

  // Continue a completed/failed issue with a follow-up prompt.
  // Reads the saved sessionId from the issue, flips status back to
  // in_progress, records a "continued" event, and pushes issue_continue to
  // the assigned worker over WS so it can re-spawn its CLI with --resume.
  // Body: { prompt: string, continuedBy?: string }
  apiRouter.post("/issues/:id/continue", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }
    if (issue.status !== "completed" && issue.status !== "failed") {
      res.status(400).json({ error: `Cannot continue an issue in status "${issue.status}"` });
      return;
    }
    if (!issue.assigned_to) {
      res.status(400).json({ error: "Issue has no assignee — cannot continue" });
      return;
    }
    const agent = db.getAgentByName(issue.assigned_to);
    if (!agent) {
      res.status(400).json({ error: `Assignee "${issue.assigned_to}" is not a registered agent` });
      return;
    }
    if (agent.status !== "online") {
      // 先校验在线;离线时直接拒绝,避免 issue 卡在 in_progress 但 worker
      // 收不到消息。用户重连 worker 再点继续即可。
      res.status(409).json({ error: `Assignee "${issue.assigned_to}" is offline — bring the worker online and retry` });
      return;
    }
    const continuedBy = typeof req.body?.continuedBy === "string" && req.body.continuedBy
      ? req.body.continuedBy
      : "dashboard-user";
    // 翻回 in_progress;result/error_message 清空,避免旧的成功结果被误读为本轮结果。
    db.updateIssueStatus(req.params.id, "in_progress", {
      result: null,
      errorMessage: null,
    });
    db.addIssueEvent({
      issueId: req.params.id,
      eventType: "continued",
      agentName: continuedBy,
      content: prompt,
      metadata: { sessionId: issue.session_id || undefined, cliTool: issue.cli_tool || undefined },
    });
    let pushed = false;
    if (hub) {
      pushed = hub.pushIssueContinue(req.params.id, prompt);
      hub.notifyIssueChanged(req.params.id, issue.group_id, "event_appended");
    }
    log.info(`Issue ${req.params.id} continue by ${continuedBy} → ${issue.assigned_to}: pushed=${pushed}, session=${issue.session_id || "(none)"}`);
    res.json({ ok: true, pushed });
  });

  // Append an instruction to an in-flight issue. Unlike /continue (which
  // requires completed/failed), /append accepts open/in_progress and lets
  // the worker queue the prompt for after the current CLI invocation
  // finishes. Mirrors Claude Code's "type while running, picked up next
  // turn" pattern. Body: { prompt: string, appendedBy?: string }
  apiRouter.post("/issues/:id/append", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) { res.status(400).json({ error: "prompt is required" }); return; }
    if (issue.status !== "open" && issue.status !== "in_progress") {
      res.status(400).json({ error: `Cannot append to an issue in status "${issue.status}"` });
      return;
    }
    if (!issue.assigned_to) {
      res.status(400).json({ error: "Issue has no assignee — cannot append" });
      return;
    }
    const agent = db.getAgentByName(issue.assigned_to);
    if (!agent) {
      res.status(400).json({ error: `Assignee "${issue.assigned_to}" is not a registered agent` });
      return;
    }
    if (agent.status !== "online") {
      res.status(409).json({ error: `Assignee "${issue.assigned_to}" is offline — bring the worker online and retry` });
      return;
    }
    const appendedBy = typeof req.body?.appendedBy === "string" && req.body.appendedBy
      ? req.body.appendedBy
      : "dashboard-user";
    db.addIssueEvent({
      issueId: req.params.id,
      eventType: "appended",
      agentName: appendedBy,
      content: prompt,
      metadata: { status: "queued", queuedAt: new Date().toISOString() },
    });
    let pushed = false;
    if (hub) {
      pushed = hub.pushIssueAppend(req.params.id, prompt);
      hub.notifyIssueChanged(req.params.id, issue.group_id, "event_appended");
    }
    log.info(`Issue ${req.params.id} append by ${appendedBy} → ${issue.assigned_to}: pushed=${pushed}`);
    res.json({ ok: true, queued: true, pushed });
  });

  // Complete issue - used by dashboard to mark an issue as done
  apiRouter.post("/issues/:id/complete", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.status === "completed" || issue.status === "failed" || issue.status === "cancelled") {
      res.status(400).json({ error: "Cannot complete an issue in status \"" + issue.status + "\"" });
      return;
    }
    const completedBy = req.body.completedBy || "system";
    db.updateIssueStatus(req.params.id, "completed");
    db.addIssueEvent({
      issueId: req.params.id, eventType: "completed",
      agentName: completedBy,
    });
    if (hub && issue.group_id) {
      hub.postSystemToGroup(issue.group_id, `✅ Issue 「${issue.title}」已完成`);
    }
    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    res.json({ ok: true });
  });

  // Claim next issue (used by executor agents)
  apiRouter.post("/issues/claim-next", (req, res) => {

    const { agentName } = req.body;
    if (!agentName) {
      res.status(400).json({ error: "agentName is required" });
      return;
    }
    const issue = db.claimNextIssue(agentName);
    if (!issue) {
      res.json(null);
      return;
    }
    db.addIssueEvent({
      issueId: issue.id, eventType: "started",
      agentName, content: `Claimed and started by ${agentName}`,
    });
    if (hub) hub.notifyIssueChanged(issue.id, issue.group_id, "updated");
    res.json(issue);
  });

  // Resolve a pending approval request raised by the executor (codex etc.).
  // Body: { decision: "accept" | "deny", resolvedBy?: string, feedback?: string }
  // `feedback` only applies to deny — it's the free-text reason the user
  // typed in the dashboard; we trim + cap it before persisting and forwarding.
  // Concurrency: the metadata.status check below makes the first POST win
  // and any duplicate from a second tab gets a 409.
  apiRouter.post("/issues/:id/approvals/:approvalId", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    const decision = req.body?.decision as "accept" | "deny" | undefined;
    if (decision !== "accept" && decision !== "deny") {
      res.status(400).json({ error: "decision must be 'accept' or 'deny'" });
      return;
    }
    const event = db.findApprovalEvent(req.params.id, req.params.approvalId);
    if (!event) { res.status(404).json({ error: "Approval not found" }); return; }
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(event.metadata || "{}"); } catch { /* fall back */ }
    if (meta.status && meta.status !== "pending") {
      res.status(409).json({ error: `Approval already ${meta.status}` });
      return;
    }
    const resolvedBy = typeof req.body?.resolvedBy === "string" && req.body.resolvedBy
      ? req.body.resolvedBy
      : "dashboard-user";
    const feedback = decision === "deny"
      && typeof req.body?.feedback === "string"
      && req.body.feedback.trim()
      ? req.body.feedback.trim().slice(0, 2000)
      : undefined;
    const updated = db.updateApprovalStatus(
      event.id,
      decision === "accept" ? "accepted" : "denied",
      resolvedBy,
      feedback,
    );
    if (!updated) {
      res.status(500).json({ error: "Failed to persist approval status" });
      return;
    }
    if (hub) {
      hub.pushApprovalResponse(req.params.id, req.params.approvalId, decision, feedback);
      hub.notifyIssueChanged(req.params.id, issue.group_id, "event_appended");
    }
    res.json({ ok: true });
  });

  // Get issue events timeline
  apiRouter.get("/issues/:id/events", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(db.getIssueEvents(req.params.id));
  });

  // Get group messages associated with a collaboration issue.
  // Only returns the messages that were recorded as collaboration_turn events.
  apiRouter.get("/issues/:id/messages", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const events = db.getIssueEvents(req.params.id)
      .filter((e) => e.event_type === "collaboration_turn");
    const messages = events.map((e) => {
      let round = 0;
      try { round = (JSON.parse(e.metadata || "{}").round as number) ?? 0; } catch { /* ignore */ }
      return {
        id: e.id,
        round,
        agentName: e.agent_name,
        content: e.content,
        createdAt: e.created_at,
      };
    });
    res.json(messages);
  });

  // Delete issue
  apiRouter.delete("/issues/:id", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    db.deleteIssue(req.params.id);
    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "deleted");
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Collaboration issues (multi-agent collaboration)
  // ═══════════════════════════════════════════════════════════════════════════

  // Get available real persons (agents with category "真人")
  apiRouter.get("/real-persons", (_req, res) => {
    const allAgents = db.listAgents();
    const realPersonAgents = allAgents
      .filter(a => {
        try {
          const profile = a.profile ? JSON.parse(a.profile) : {};
          return profile.category === "真人";
        } catch { return false; }
      })
      .map(a => ({ name: a.name, id: a.id }));
    res.json(realPersonAgents);
  });

  // Create collaboration issue
  apiRouter.post("/groups/:groupId/collaborations", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot create collaborations" }); return; }
    const { title, collaborationGoal, participants, maxRounds, owner, createdBy } = req.body;
    if (!title || !collaborationGoal || !participants?.length) {
      res.status(400).json({ error: "title, collaborationGoal, and participants are required" });
      return;
    }
    // Owner is optional. If provided, it must be a registered agent with category "真人".
    if (owner) {
      const ownerAgent = db.getAgentByName(owner);
      if (!ownerAgent) {
        res.status(400).json({ error: `Owner "${owner}" is not a registered agent` });
        return;
      }
      try {
        const ownerProfile = ownerAgent.profile ? JSON.parse(ownerAgent.profile) : {};
        if (ownerProfile.category !== "真人") {
          res.status(400).json({ error: `Owner must be a "真人" type agent` });
          return;
        }
      } catch {
        res.status(400).json({ error: `Owner profile parse error` });
        return;
      }
    }
    if (participants.length < 2) {
      res.status(400).json({ error: "At least 2 participants are required" });
      return;
    }
    const id = randomUUID();
    db.createCollaborationIssue({
      id,
      groupId: req.params.groupId,
      title,
      collaborationGoal,
      participants,
      maxRounds: maxRounds || 3,
      owner: owner || "",
      createdBy: createdBy || "dashboard",
    });
    log.info(`Collaboration created: "${title}" (${id}) in group ${req.params.groupId}`);

    // 协作只通知 participants[0]，由其自主决策 @ 下一个成员或结束 issue
    if (hub) {
      const firstParticipant = participants[0];
      const agent = db.getAgentByName(firstParticipant);
      if (agent) {
        const sent = hub.sendToAgent(agent.id, {
          type: "collaboration_started",
          issueId: id,
          groupId: req.params.groupId,
          title,
          collaborationGoal,
          participants,
          maxRounds: maxRounds || 3,
          owner: owner || undefined,
          round: 1,
        });
        log.info(`Collaboration notify ${firstParticipant} (agentId=${agent.id}): sent=${sent}`);
      } else {
        log.warn(`Collaboration first participant "${firstParticipant}" not found in DB`);
      }

      // 群内可见的启动消息：以 @<firstParticipant> 开头，
      // 让普通 agent 走标准 a2a_message + mention 路径被唤起。
      const ownerLine = owner ? `\n\n负责人：${owner}` : "";
      const startupContent =
        `@${firstParticipant} 🤝 [协作启动] 由你担任发起人，请开始协作任务「${title}」\n\n` +
        `目标：\n${collaborationGoal}\n\n` +
        `参与者：\n${participants.join("、")}\n\n` +
        `最大轮数：\n${maxRounds || 3}` + ownerLine + `\n\n` +
        `IssueId：${id}`;
      hub.postSystemToGroup(req.params.groupId, startupContent, [], [firstParticipant]);
      hub.notifyIssueChanged(id, req.params.groupId, "created");
    } else {
      log.warn("Collaboration created but hub is not available for WS notification");
    }

    res.status(201).json({ id, title, status: "in_progress", type: "collaboration" });
  });

  // Manually conclude a collaboration
  apiRouter.post("/issues/:id/conclude-collaboration", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.type !== "collaboration") {
      res.status(400).json({ error: "Not a collaboration issue" });
      return;
    }
    if (issue.status !== "in_progress") {
      res.status(400).json({ error: "Collaboration is not in progress" });
      return;
    }
    const { summary } = req.body;
    if (!summary) {
      res.status(400).json({ error: "summary is required" });
      return;
    }
    const participants: string[] = JSON.parse(issue.participants || "[]");
    db.completeCollaboration(req.params.id, summary);

    // Notify participants via WS
    if (hub) {
      for (const participant of participants) {
        const agent = db.getAgentByName(participant);
        if (agent) {
          hub.sendToAgent(agent.id, {
            type: "collaboration_concluded",
            issueId: req.params.id,
            groupId: issue.group_id,
            title: issue.title,
            summary,
            totalRounds: issue.current_round ?? 0,
            owner: issue.owner || undefined,
          });
        }
      }
      hub.postSystemToGroup(issue.group_id, `🏁 [协作结束] 协作任务「${issue.title}」已由 dashboard 主动结束。\n\n${summary}`);
      hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    }

    log.info(`Collaboration concluded: "${issue.title}" (${req.params.id})`);
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Artifacts — 读取 ~/.rotom/results/[groupId] 下的产物文件
  // ═══════════════════════════════════════════════════════════════════════════

  // List artifact files for a group
  apiRouter.get("/artifacts/:groupId", (req, res) => {
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    if (!fs.existsSync(groupDir)) {
      res.json([]);
      return;
    }

    interface FileEntry {
      name: string;
      path: string;
      absPath: string;
      size: number;
      modifiedTime: string;
      type: "file" | "directory";
      children?: FileEntry[];
    }

    function walkDir(dir: string, base: string): FileEntry[] {
      const entries: FileEntry[] = [];
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return entries;
      }
      for (const item of items) {
        if (item.name.startsWith(".")) continue;
        if (item.name === "node_modules") continue;
        const fullPath = path.join(dir, item.name);
        const relPath = path.relative(base, fullPath);
        if (item.isDirectory()) {
          entries.push({
            name: item.name,
            path: relPath,
            absPath: fullPath,
            size: 0,
            modifiedTime: fs.statSync(fullPath).mtime.toISOString(),
            type: "directory",
            children: walkDir(fullPath, base),
          });
        } else if (item.isFile()) {
          const stat = fs.statSync(fullPath);
          entries.push({
            name: item.name,
            path: relPath,
            absPath: fullPath,
            size: stat.size,
            modifiedTime: stat.mtime.toISOString(),
            type: "file",
          });
        }
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries;
    }

    res.json({
      root: groupDir,
      files: walkDir(groupDir, groupDir),
    });
  });

  // Read artifact file content
  apiRouter.get("/artifacts/:groupId/content", (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    const resolved = path.resolve(groupDir, filePath);
    // Path traversal check
    if (!resolved.startsWith(path.resolve(groupDir))) {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const stat = fs.statSync(resolved);
    const MAX_SIZE = 500 * 1024; // 500KB
    if (stat.size > MAX_SIZE) {
      res.json({ path: filePath, content: `[File too large: ${(stat.size / 1024).toFixed(1)}KB]`, size: stat.size, type: "text" as const });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const binaryExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip"]);
    if (binaryExts.has(ext)) {
      const buf = fs.readFileSync(resolved);
      res.json({ path: filePath, content: buf.toString("base64"), size: stat.size, type: "binary" as const });
    } else {
      const content = fs.readFileSync(resolved, "utf-8");
      res.json({ path: filePath, content, size: stat.size, type: "text" as const });
    }
  });

  // Return the file content at a given git ref (`base`, default HEAD), so the
  // dashboard can feed it as `original` to a Monaco DiffEditor. Walks up to
  // find the enclosing .git, then runs `git show <base>:<relInRepo>`.
  apiRouter.get("/artifacts/:groupId/original", (req, res) => {
    const filePath = req.query.path as string;
    const base = (req.query.base as string) || "HEAD";
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(base)) {
      res.status(400).json({ error: "Invalid base ref" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    const resolved = path.resolve(groupDir, filePath);
    if (!resolved.startsWith(path.resolve(groupDir))) {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    let cursor = path.dirname(resolved);
    let repoRoot: string | null = null;
    const stopAt = path.parse(cursor).root;
    while (cursor && cursor !== stopAt) {
      if (fs.existsSync(path.join(cursor, ".git"))) {
        repoRoot = cursor;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!repoRoot) {
      res.json({ path: filePath, base, repoRoot: null, content: "", note: "目标文件不在 git 仓库中。" });
      return;
    }
    const relInRepo = path.relative(repoRoot, resolved);
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const result = spawnSync("git", ["show", `${base}:${relInRepo}`], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error) {
      res.status(500).json({ error: `git show failed: ${result.error.message}` });
      return;
    }
    if (result.status !== 0) {
      // file did not exist at base — return empty so DiffEditor shows full add
      res.json({
        path: filePath,
        base,
        repoRoot,
        relInRepo,
        content: "",
        note: result.stderr?.trim() || `file not present at ${base}`,
      });
      return;
    }
    res.json({
      path: filePath,
      base,
      repoRoot,
      relInRepo,
      content: result.stdout,
    });
  });

  // Compute `git diff <base> -- <file>` for an artifact file. Useful when the
  // artifact lives in a git working tree and the caller wants to review
  // pending changes against a ref (default HEAD).
  apiRouter.get("/artifacts/:groupId/diff", (req, res) => {
    const filePath = req.query.path as string;
    const base = (req.query.base as string) || "HEAD";
    if (!filePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    // Reject obviously dangerous bases — only refs / commits / short shas.
    if (!/^[A-Za-z0-9_./~^@-]+$/.test(base)) {
      res.status(400).json({ error: "Invalid base ref" });
      return;
    }
    const groupDir = resolveGroupArtifactRoot(db, req.params.groupId);
    const resolved = path.resolve(groupDir, filePath);
    if (!resolved.startsWith(path.resolve(groupDir))) {
      res.status(403).json({ error: "Invalid path" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    // Walk up to find a .git directory — the artifact may sit inside a repo
    // that's a subtree of ~/.rotom/results/<groupId>.
    let cursor = path.dirname(resolved);
    let repoRoot: string | null = null;
    const stopAt = path.parse(cursor).root;
    while (cursor && cursor !== stopAt) {
      if (fs.existsSync(path.join(cursor, ".git"))) {
        repoRoot = cursor;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (!repoRoot) {
      res.json({ path: filePath, base, repoRoot: null, diff: "", note: "目标文件不在 git 仓库中，无法计算 diff。" });
      return;
    }
    const relInRepo = path.relative(repoRoot, resolved);
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const result = spawnSync("git", ["diff", "--no-color", base, "--", relInRepo], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error) {
      res.status(500).json({ error: `git diff failed: ${result.error.message}` });
      return;
    }
    if (result.status !== 0 && result.status !== null) {
      res.status(500).json({
        error: `git diff exited ${result.status}`,
        stderr: result.stderr,
      });
      return;
    }
    res.json({
      path: filePath,
      base,
      repoRoot,
      relInRepo,
      diff: result.stdout,
    });
  });

  return apiRouter;
}

function parseProfile(raw: string | null | undefined): AgentProfile | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AgentProfile;
  } catch {
    return undefined;
  }
}
