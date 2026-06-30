import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import { defaultGroupWorkingDir } from "../group-paths.js";
import { createLogger } from "../../shared/logger.js";
import { parseAgentProfile, mergeGroupProfile } from "../../shared/agent-profile.js";

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

    // 巡检群:全局限 1 个未归档 + 仅 1 个 agent(除 creator 外)
    if (type === "patrol") {
      const existing = db.listGroupsByType("patrol").filter((g) => g.archived_at == null);
      if (existing.length > 0) {
        res.status(400).json({
          error: `已存在未归档的巡检群 "${existing[0].name}",需归档或删除后才能再建`,
        });
        return;
      }
      const picked = Array.isArray(memberNames) ? memberNames.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
      if (picked.length !== 1) {
        res.status(400).json({ error: "巡检群限选 1 个 agent(该 agent 即巡检员)" });
        return;
      }
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

    // 巡检群:建群后自动建 issue-patrol 定时任务 + 绑定规则 skill
    if (type === "patrol") {
      const patrolAgentName = (Array.isArray(memberNames) ? memberNames : []).find(
        (n): n is string => typeof n === "string" && !!n.trim(),
      );
      if (patrolAgentName) {
        const payload = {
          patrolGroupId: id,
          patrolAgentName,
          throughputCap: 3,
          candidateCap: 3,
          scanBatch: 10,
        };
        db.createScheduledTask({
          name: "Issue 巡检",
          groupId: id,
          mode: "agent", // handler 模式下 mode 不被使用,但 schema NOT NULL,保留 agent
          agentName: patrolAgentName,
          scheduleKind: "interval",
          intervalSec: 3600,
          prompt: "", // handler 模式不用 prompt,但 schema NOT NULL
          enabled: true,
          handlerKey: "issue-patrol",
          handlerPayload: JSON.stringify(payload),
        });
        const skill = db.getSkillByName("issue-patrol-rules");
        if (skill) {
          db.bindSkill({
            groupId: id,
            agentName: patrolAgentName,
            skillId: skill.id,
            createdBy: "system:patrol-bootstrap",
          });
          log.info(`Patrol group ${id}: bound issue-patrol-rules to ${patrolAgentName}`);
        } else {
          log.warn(`Patrol group ${id}: issue-patrol-rules skill not found, skip binding`);
        }
        log.info(`Patrol group ${id}: auto-created issue-patrol schedule (interval 3600s, enabled)`);
      }
    }

    res.status(201).json({ id, name: name.trim(), working_dir: workDir, type: type || null, memberCount: Array.isArray(memberNames) ? memberNames.length : 0 });
  });

  apiRouter.patch("/groups/:id", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const { name, workingDir, pinned, archived, guidancePrompt } = req.body;
    if (name !== undefined && name !== null) {
      db.updateGroupName(req.params.id, String(name));
      log.info(`Group ${req.params.id} name → ${name}`);
    }
    if (workingDir === undefined && name === undefined && pinned === undefined && archived === undefined && guidancePrompt === undefined) {
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
    if (guidancePrompt !== undefined) {
      const v = typeof guidancePrompt === "string" ? guidancePrompt : null;
      db.updateGroupGuidancePrompt(req.params.id, v);
      log.info(`Group ${req.params.id} guidance_prompt → ${v ? `(${v.length} chars)` : "(cleared)"}`);
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
    const members = db.getGroupMembers(req.params.id).map((m) => {
      const agent = db.getAgentByName(m.agent_name);
      const base = agent?.profile ? parseAgentProfile(agent.profile) : null;
      const override = parseAgentProfile(m.profile);
      const effective = mergeGroupProfile(base, override);
      return {
        agent_name: m.agent_name,
        joined_at: m.joined_at,
        status: agent?.status ?? "offline",
        profile: effective,
      };
    });
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

  // Set or update the per-(group, agent) profile override.
  // Body: { position?, bio?, category? } — fields with undefined/null are
  // dropped from the override (not stored). An empty body clears the override.
  // Stored as JSON in group_member_settings.profile; dispatch-enrich merges it
  // onto the agent's global profile (group-level fields win).
  apiRouter.put("/groups/:id/members/:agentName/profile", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot modify settings" }); return; }
    const agentName = String(req.params.agentName);
    const members = db.getGroupMembers(req.params.id);
    if (!members.some(m => m.agent_name === agentName)) {
      res.status(404).json({ error: `Agent "${agentName}" is not a member of this group` });
      return;
    }
    const body = req.body ?? {};
    const profile: Record<string, string> = {};
    if (typeof body.position === "string" && body.position.trim()) profile.position = body.position.trim();
    if (typeof body.bio === "string" && body.bio.trim()) profile.bio = body.bio.trim();
    if (typeof body.category === "string" && body.category.trim()) profile.category = body.category.trim();
    const profileJson = Object.keys(profile).length > 0 ? JSON.stringify(profile) : null;
    db.upsertGroupMemberProfile(req.params.id, agentName, profileJson);
    log.info(`Group ${req.params.id} member ${agentName} profile → ${profileJson ?? "(cleared)"}`);
    res.json({ ok: true, profile });
  });

  apiRouter.get("/groups/:id/messages", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    // 新签名是 (headKeep, tailKeep)。?limit= 仍接受,当作 head+tail 总预算
    // 分配(head 固定 5);不带 limit 时走 db 层默认 head=5 / tail=295。
    if (Object.prototype.hasOwnProperty.call(req.query, "limit")) {
      const total = Math.min(parseInt(req.query.limit as string) || 300, 500);
      res.json(db.getGroupMessages(req.params.id, 5, Math.max(total - 5, 0)));
    } else {
      res.json(db.getGroupMessages(req.params.id));
    }
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
    const msgId = db.addGroupMessage(req.params.id, sender, content, resolvedMentions);

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

      // 对齐 ws-hub a2a_reply 路径(connection.ts:403-404 + trackCollaborationTurn):
      // 真人 @ 回复也要走 bridge 检测,否则 pending bridge 不会在入库时 mark answered,
      // 20s 后 handler 兜底会再发一条 system 复述,跟真人原始 @ 重复(见群 34dd5eee)。
      hub.autoCreateBridgeOnMention(req.params.id, sender, resolvedMentions, msgId);
      hub.checkAndCancelBridgesForMessage(req.params.id, sender, resolvedMentions, msgId);
      hub.trackCollaborationTurn(req.params.id, sender, content);
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

  /** GET /api/groups/:id/asks?status=pending —— 列出群里的 bridge */
  apiRouter.get("/groups/:id/asks", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status as any : undefined;
    const bridges = db.listAskBridges({ groupId: req.params.id, status });
    res.json(bridges);
  });

  /** GET /api/asks/:id —— 单条 bridge 详情 */
  apiRouter.get("/asks/:id", (req, res) => {
    const bridge = db.getAskBridge(req.params.id);
    if (!bridge) { res.status(404).json({ error: "Bridge not found" }); return; }
    res.json(bridge);
  });

  /** POST /api/asks/:id/cancel —— A 主动 cancel(收到非@回复,自己判断是回复了) */
  apiRouter.post("/asks/:id/cancel", (req, res) => {
    const ok = db.cancelBridge(req.params.id);
    if (!ok) { res.status(409).json({ error: "Bridge not pending (already resolved)" }); return; }
    log.info(`Ask bridge cancelled: ${req.params.id}`);
    res.json({ ok: true });
  });
}
