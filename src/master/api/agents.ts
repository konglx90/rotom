import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { MeshDb, AgentRow } from "../db.js";
import type { AuthService } from "../auth.js";
import { hashToken } from "../auth.js";
import type { WSHub } from "../ws-hub.js";
import type { AgentProfile } from "../../shared/protocol.js";
import { DEFAULT_MASTER_PORT } from "../../shared/constants.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

function parseProfile(raw: string | null | undefined): AgentProfile | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AgentProfile;
  } catch {
    return undefined;
  }
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

export function registerAgentRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  auth: AuthService,
  _hub?: WSHub,
  serverPort?: number,
): void {
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
      avatar_url: a.avatar_url,
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

  apiRouter.post("/agents", (req, res) => {
    const { name, description, domain, profile } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }

    if (!domain || typeof domain !== "string") {
      res.status(400).json({ error: "domain is required" });
      return;
    }

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

    const port = serverPort ?? DEFAULT_MASTER_PORT;
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
      avatar_url: agent.avatar_url,
      token: agent.token,
    });
  });

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

  apiRouter.put("/agents/:id", (req, res) => {
    const agent = db.getAgentById(req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const { name, description, domain, enabled, profile, avatar_url } = req.body;
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
    if (description !== undefined || domain !== undefined || profile !== undefined || avatar_url !== undefined) {
      db.updateAgentMeta(agent.id, {
        description,
        domain,
        profile: profile !== undefined ? JSON.stringify(profile) : undefined,
        avatar_url,
      });
    }
    if (enabled !== undefined) {
      db.updateAgentEnabled(agent.id, !!enabled);
    }

    if (_hub) {
      if (domain !== undefined || enabled !== undefined) {
        _hub.pushConfigUpdate(agent.id, {
          domain: domain ?? agent.domain ?? undefined,
          enabled: enabled !== undefined ? !!enabled : agent.enabled !== 0,
        });
      }
      _hub.broadcastAgentUpdate(agent.id);
    }

    res.json({ ok: true });
  });

  apiRouter.post("/agents/avatar", (req, res) => {
    const { agentId, dataBase64, mimeType } = req.body || {};

    if (typeof agentId !== "string" || !agentId.trim()) {
      res.status(400).json({ error: "agentId is required" });
      return;
    }
    const agent = db.getAgentById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (typeof dataBase64 !== "string" || !dataBase64) {
      res.status(400).json({ error: "dataBase64 is required" });
      return;
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch (e: any) {
      res.status(400).json({ error: `base64 decode failed: ${e?.message ?? "unknown"}` });
      return;
    }

    if (buf.length > 2 * 1024 * 1024) {
      res.status(400).json({ error: "avatar too large: max 2MB" });
      return;
    }

    const allowedMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    const actualMime = mimeType && allowedMimes.includes(mimeType as string) ? mimeType : "image/png";
    const ext = (actualMime as string).includes("png") ? "png"
      : (actualMime as string).includes("gif") ? "gif"
      : (actualMime as string).includes("webp") ? "webp" : "jpg";

    const rand = randomUUID().replace(/-/g, "").slice(0, 6);
    const avatarDir = "/tmp/rotom-avatars";
    fs.mkdirSync(avatarDir, { recursive: true });
    const stamp = Date.now();
    const storedName = `${agentId}-${stamp}-${rand}.${ext}`;
    const absPath = path.join(avatarDir, storedName);
    fs.writeFileSync(absPath, buf);
    const url = `/api/avatars/${storedName}`;
    db.updateAgentMeta(agent.id, { avatar_url: url });
    log.info(`avatar saved for agent ${agent.name}: ${url}`);
    res.status(201).json({ url });
  });

  apiRouter.get("/avatars/:filename", (req, res) => {
    const { filename } = req.params;
    if (!filename || filename.includes("/") || filename.includes("\\")) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const avatarDir = "/tmp/rotom-avatars";
    const abs = path.resolve(avatarDir, filename);
    if (!abs.startsWith(path.resolve(avatarDir) + path.sep)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    res.setHeader("Content-Type", mimeMap[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(abs).pipe(res);
  });

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
}
