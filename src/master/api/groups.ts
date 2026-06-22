import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import { defaultGroupWorkingDir } from "../group-paths.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

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

export function registerGroupRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  _auth: unknown,
  hub?: WSHub,
): void {
  // Backfill legacy groups with no working_dir
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

  apiRouter.get("/groups", (_req, res) => {
    res.json(db.listGroupsWithMembers());
  });

  apiRouter.post("/groups", (req, res) => {
    const { name, memberNames, workingDir, type } = req.body;
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
      workDir = defaultGroupWorkingDir(id);
      try {
        ensureDir(workDir);
      } catch (err: any) {
        res.status(500).json({ error: `创建默认工作目录失败: ${workDir} (${err?.code ?? err?.message ?? "unknown"})` });
        return;
      }
    }
    if (type && typeof type === "string") {
      db.createGroupTyped({ id, name: name.trim(), type, workingDir: workDir });
    } else {
      db.createGroup(id, name.trim(), undefined, workDir);
    }
    if (Array.isArray(memberNames) && memberNames.length > 0) {
      db.addGroupMembers(id, memberNames);
    }
    log.info(`Group created: "${name.trim()}" (${id}) type=${type || "default"} cwd=${workDir}`);
    res.status(201).json({ id, name: name.trim(), working_dir: workDir, type: type || null, memberCount: Array.isArray(memberNames) ? memberNames.length : 0 });
  });

  apiRouter.patch("/groups/:id", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const { name, workingDir, pinned, archived } = req.body;
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

  // Set or update the per-(group, agent) working_dir override.
  // Body: { workingDir: "<absolute path>" }
  apiRouter.put("/groups/:id/members/:agentName/working-dir", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot modify settings" }); return; }
    const agentName = String(req.params.agentName);
    const members = db.getGroupMembers(req.params.id);
    if (!members.some(m => m.agent_name === agentName)) {
      res.status(404).json({ error: `Agent "${agentName}" is not a member of this group` });
      return;
    }
    const v = validateWorkingDir(req.body?.workingDir);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    db.upsertGroupMemberSetting(req.params.id, agentName, v.path);
    log.info(`Group ${req.params.id} member ${agentName} working_dir → ${v.path}`);
    res.json({ ok: true, working_dir: v.path });
  });

  // Clear the per-(group, agent) working_dir override. Falls back to
  // group.working_dir for resolution.
  apiRouter.delete("/groups/:id/members/:agentName/working-dir", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot modify settings" }); return; }
    const agentName = String(req.params.agentName);
    const members = db.getGroupMembers(req.params.id);
    if (!members.some(m => m.agent_name === agentName)) {
      res.status(404).json({ error: `Agent "${agentName}" is not a member of this group` });
      return;
    }
    const removed = db.clearGroupMemberSetting(req.params.id, agentName);
    log.info(`Group ${req.params.id} member ${agentName} working_dir cleared (removed=${removed})`);
    res.json({ ok: true, removed });
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
    // 解析 mentions:优先用 body 里的,否则从 content 抽(同 ws-hub.ts:390 正则)
    const resolvedMentions = Array.isArray(mentions) && mentions.length > 0
      ? mentions
      : (content.match(/@([\w一-鿿][\w.一-鿿-]*)/g)?.map((m: string) => m.slice(1)) ?? []);
    db.addGroupMessage(req.params.id, sender, content, resolvedMentions);

    // ── 真人发群消息:广播给所有群成员 ─────────────────────────────
    // 行为对齐 ws-hub.ts:462-465 (a2a_reply 对群消息做的 broadcastToGroup)。
    if (hub) {
      const senderAgent = db.getAgentByName(sender);
      if (!senderAgent) {
        // 兜底:sender 不是注册 agent,DB 已入库但 WS 不广播,仍 200。
        log.warn(`POST /groups/:id/messages: sender "${sender}" not registered; skip broadcast`);
      } else {
        // 兜底:真人不在 group_members 时补 addMembers(防"自激丢消息" +
        // "多 tab 真人看不到自己的消息")。INSERT OR IGNORE 幂等。
        const members = db.getGroupMembers(req.params.id);
        if (!members.some((m) => m.agent_name === sender)) {
          db.addGroupMembers(req.params.id, [sender]);
          log.info(`POST /groups/:id/messages: auto-joined sender "${sender}" as group member`);
        }

        const wireMsg = {
          type: "a2a_message" as const,
          requestId: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          from: { name: sender, domain: senderAgent.domain || undefined, status: "online" as const },
          payload: { message: content },
          routeType: "exact" as const,
          conversation: { type: "group" as const, groupId: req.params.id, groupName: group.name },
        };
        // 排除 @mentioned agent:这些目标会由 Dashboard 后续 a2a_send 直投,
        // 这里再广播一次会导致目标 agent 重复处理(同 ws-hub.ts:445 行为)。
        const mentionAgentIds = resolvedMentions
          .map((name: string) => db.getAgentByName(name)?.id)
          .filter((id: string | undefined): id is string => !!id);
        hub.broadcastToGroupPublic(req.params.id, wireMsg, [senderAgent.id, ...mentionAgentIds]);
      }
    }

    db.logMessage({
      requestId: `grp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      fromName: sender,
      direction: "send",
      payload: JSON.stringify({ message: content, mentions: resolvedMentions, groupName: group.name }),
      status: "group_message",
      groupId: group.id,
      source: "api",
    });

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

  // Real persons (agents with category "真人")
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

  // Cross-domain rules
  apiRouter.get("/cross-domain", (_req, res) => {
    const rules = db.listCrossDomainRules();
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
}
