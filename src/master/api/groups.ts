import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import { defaultGroupWorkingDir } from "../group-paths.js";
import { scanAllRepos, resolveGroupWorktreeInfo } from "../repo-scan.js";
import { createLogger } from "../../shared/logger.js";
import { isLoopback } from "../../shared/network.js";
import { parseAgentProfile, mergeGroupProfile } from "../../shared/agent-profile.js";
import { extractMentions } from "../../shared/mention.js";
import { validateWorkingDir } from "../util/paths.js";
import { bootstrapPatrolGroup } from "../services/patrol-bootstrap.js";
import { bootstrapLinkPatrolGroup } from "../services/link-patrol-bootstrap.js";
import { collectLinksFromText } from "../services/link-collector.js";

const log = createLogger("mesh-api");

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
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

    // 链接分类巡检群(type=patrol-link):同 patrol 约束,但独立计数(允许和 patrol 共存)
    if (type === "patrol-link") {
      const existing = db.listGroupsByType("patrol-link").filter((g) => g.archived_at == null);
      if (existing.length > 0) {
        res.status(400).json({
          error: `已存在未归档的链接分类巡检群 "${existing[0].name}",需归档或删除后才能再建`,
        });
        return;
      }
      const picked = Array.isArray(memberNames) ? memberNames.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
      if (picked.length !== 1) {
        res.status(400).json({ error: "链接分类巡检群限选 1 个 agent(该 agent 即巡检员)" });
        return;
      }
    }

    // 单播群(unicast):消息不广播、worker 不被消息自动唤醒,只通过 CLI
    // --need-reply 显式点名叫醒对方回话。建群 ≥2 成员,不限上限。
    if (type === "a2a_direct") {
      const picked = Array.isArray(memberNames) ? memberNames.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
      if (picked.length < 2) {
        res.status(400).json({ error: "单播群至少需要 2 个成员" });
        return;
      }
      if (new Set(picked).size !== picked.length) {
        res.status(400).json({ error: "单播群成员不能重复" });
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
        bootstrapPatrolGroup(db, log, id, patrolAgentName);
      }
    }

    // 链接分类巡检群:建群后自动建 link-patrol 定时任务 + 绑定 link-patrol-rules skill
    if (type === "patrol-link") {
      const patrolAgentName = (Array.isArray(memberNames) ? memberNames : []).find(
        (n): n is string => typeof n === "string" && !!n.trim(),
      );
      if (patrolAgentName) {
        bootstrapLinkPatrolGroup(db, log, id, patrolAgentName);
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
    const { name, workingDir, pinned, archived, starred, guidancePrompt, repoUrl, repoDefaultBranch, extraRepos, worktreeMode } = req.body;
    if (name !== undefined && name !== null) {
      db.updateGroupName(req.params.id, String(name));
      log.info(`Group ${req.params.id} name → ${name}`);
    }
    if (workingDir === undefined && name === undefined && pinned === undefined && archived === undefined && starred === undefined && guidancePrompt === undefined && repoUrl === undefined && repoDefaultBranch === undefined && extraRepos === undefined && worktreeMode === undefined) {
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
    if (starred !== undefined) {
      const next = db.updateGroupStarred(req.params.id, Boolean(starred));
      log.info(`Group ${req.params.id} starred_at → ${next ?? "null"}`);
    }
    if (guidancePrompt !== undefined) {
      const v = typeof guidancePrompt === "string" ? guidancePrompt : null;
      db.updateGroupGuidancePrompt(req.params.id, v);
      log.info(`Group ${req.params.id} guidance_prompt → ${v ? `(${v.length} chars)` : "(cleared)"}`);
    }
    // 内置 repo(migration 051):三列独立 patch。任一字段 undefined 时不改动该列;
    // 显式传 null/空串则清空。extraRepos 接收数组或字符串(JSON),统一规整成 JSON 字符串存库。
    if (repoUrl !== undefined || repoDefaultBranch !== undefined || extraRepos !== undefined) {
      const url = typeof repoUrl === "string" ? repoUrl.trim() : null;
      const branch = typeof repoDefaultBranch === "string" ? repoDefaultBranch.trim() : null;
      let extraJson: string | null = null;
      if (extraRepos !== undefined && extraRepos !== null) {
        let arr: unknown;
        if (typeof extraRepos === "string") {
          try { arr = JSON.parse(extraRepos); } catch { res.status(400).json({ error: "extraRepos 不是合法 JSON" }); return; }
        } else {
          arr = extraRepos;
        }
        if (!Array.isArray(arr)) { res.status(400).json({ error: "extraRepos 必须是数组" }); return; }
        const cleaned = arr.filter((e): e is { id: string; url: string; branch?: string; mountPath: string } =>
          !!e && typeof e === "object"
          && typeof (e as any).id === "string" && (e as any).id
          && typeof (e as any).url === "string" && (e as any).url
          && typeof (e as any).mountPath === "string" && (e as any).mountPath);
        extraJson = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
      }
      db.updateGroupRepo(req.params.id, url, branch, extraJson, typeof worktreeMode === "string" ? worktreeMode : null);
      log.info(`Group ${req.params.id} repo → url=${url || "(cleared)"} branch=${branch || "(default)"} extras=${extraJson ? `(${JSON.parse(extraJson).length})` : "(none)"} mode=${worktreeMode === "issue" ? "issue" : "group"}`);
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
    // since=<ISO>:按时间过滤(轮询用),不走 head/tail 截断。
    // 接受 UTC ISO(带 Z)或北京时间字符串(无 Z),字符串字典序比较都生效。
    if (typeof req.query.since === "string" && req.query.since.trim()) {
      res.json(db.getGroupMessagesSince(req.params.id, req.query.since.trim()));
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

  // 单条消息回查:CLI `rotom group message <groupId> <msgId>` 调用,
  // 让 agent 在 history 截断后单独拉某条消息的完整 content(含工具标签)。
  apiRouter.get("/groups/:id/messages/:msgId", (req, res) => {
    const group = db.getGroupById(req.params.id);
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    const msgId = parseInt(req.params.msgId);
    if (!Number.isFinite(msgId)) { res.status(400).json({ error: "Invalid msgId" }); return; }
    const row = db.getGroupMessageById(req.params.id, msgId);
    if (!row) { res.status(404).json({ error: "Message not found" }); return; }
    res.json(row);
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
      : extractMentions(content);
    const msgId = db.addGroupMessage(req.params.id, sender, content, resolvedMentions);
    db.bumpGroupActivity(req.params.id);
    // 链接采集(inline hook,失败不影响主路径)
    try {
      collectLinksFromText(content, {
        sourceType: "group_message",
        sourceId: String(msgId),
        sourceGroupId: req.params.id,
        sourceSender: sender,
      }, db);
    } catch (err: any) {
      log.warn(`POST /groups/:id/messages: collectLinksFromText failed: ${err?.message ?? err}`);
    }

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

      // 对齐 ws-hub a2a_reply 路径(connection.ts:403-404):
      // 真人 @ 回复也要走 bridge 检测,否则 pending bridge 不会在入库时 mark answered,
      // 20s 后 handler 兜底会再发一条 system 复述,跟真人原始 @ 重复(见群 34dd5eee)。
      hub.autoCreateBridgeOnMention(req.params.id, sender, resolvedMentions, msgId);
      hub.checkAndCancelBridgesForMessage(req.params.id, sender, resolvedMentions, msgId);
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

  // ── POST /api/asks —— rotom ask <target> "<q>" 入口 ─────────────────────
  // 自动找/建 a2a_direct pair 群(协调 master 持群),写 asker 提问进群 + 建 bridge。
  // sync 模式:阻塞等 reply_msg_id 落库,5min 超时 exit (不升级 Issue)
  // async 模式:立即返回 bridgeId + groupId,5min 超时升级 Issue(沿用 #reply 路径)
  //
  // 联邦场景下协调 master 通过 federation server 收到 FedAskWithBridge
  // 后调用同一个 handleAskRequest 函数,把消息路由到目标 member master。
  apiRouter.post("/asks", async (req, res) => {
    if (!hub) { res.status(500).json({ error: "WSHub not available" }); return; }
    const { target, message, mode, timeoutMs, escalateTo } = req.body || {};
    // 鉴权:mesh token 优先;loopback(本机 CLI 直发)允许用 body.asker 兜底
    // 跟 internal network mode 对齐,本机默认信任,免去手写 mesh_token 配置
    const agentAuth = (req as any).agentAuth as { name: string } | undefined;
    const askerName = agentAuth?.name
      ?? (isLoopback(req.socket.remoteAddress) && typeof req.body?.asker === "string" && req.body.asker.trim() ? req.body.asker.trim() : null);
    if (!askerName) {
      res.status(403).json({ error: "Mesh token required (or call from loopback with body.asker)" });
      return;
    }
    if (!target || typeof target !== "string" || !target.trim()) {
      res.status(400).json({ error: "target is required" });
      return;
    }
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const bridgeMode: "sync" | "async" = mode === "async" ? "async" : "sync";
    const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 5 * 60_000;
    const escalateToStr = typeof escalateTo === "string" && escalateTo.trim() ? escalateTo.trim() : null;

    const created = handleAskRequest({
      db, hub,
      asker: askerName,
      target,
      message,
      mode: bridgeMode,
      timeoutMs: timeout,
      escalateTo: escalateToStr,
    });
    if (created.error) {
      res.status(400).json({ ok: false, error: created.error });
      return;
    }
    const { bridgeId, groupId } = created;

    // async 模式:立即返回 bridgeId + groupId
    if (bridgeMode === "async") {
      res.json({ ok: true, bridgeId, groupId, status: "pending" });
      return;
    }

    // sync 模式:阻塞轮询 bridge.status,200ms 间隔(避免 scheduler 20s tick 太慢)
    const deadline = Date.now() + timeout;
    const pollInterval = 200;
    while (Date.now() < deadline) {
      const b = db.getAskBridge(bridgeId!);
      if (!b) {
        res.status(500).json({ ok: false, error: `bridge ${bridgeId} not found after create` });
        return;
      }
      if (b.status === "answered") {
        const replyMsgId = b.reply_msg_id ?? 0;
        const replyContent = db.getGroupMessageContent(replyMsgId) ?? "";
        res.json({ ok: true, bridgeId, reply: { id: replyMsgId, content: replyContent }, status: "answered" });
        return;
      }
      if (b.status === "timed_out" || b.status === "cancelled") {
        res.json({ ok: false, bridgeId, status: b.status });
        return;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    // CLI 端 5min 到点
    db.markBridgeTimedOut(bridgeId!, null, null);
    res.json({ ok: false, bridgeId, status: "timed_out" });
  });

  // ── Worktree 视图(供 Dashboard 展示)───────────────────────────────────

  /** GET /api/groups/:id/worktree —— 当前 group 的 worktree 推算信息。
   *  返回 primary + extras 的路径(本机 FS 是否已存在)。没配 repo → 404。 */
  apiRouter.get("/groups/:id/worktree", (req, res) => {
    const info = resolveGroupWorktreeInfo(db, req.params.id);
    if (!info) { res.status(404).json({ error: "group has no repo configured" }); return; }
    res.json(info);
  });

  /** GET /api/repos/worktrees —— 全局所有 repo + worktree 列表(工具箱视图用)。
   *  扫描本机 ~/.rotom/repos/,跨机器部署时返回空。 */
  apiRouter.get("/repos/worktrees", (_req, res) => {
    res.json(scanAllRepos());
  });

  /** DELETE /api/repos/worktrees —— 删除指定 worktree(孤儿清理)。
   *  body: { path: "<worktree 绝对路径>" }。只删 worktree,bare clone 保留。
   *  路径必须在 ~/.rotom/repos/ 下,防止误删。 */
  apiRouter.delete("/repos/worktrees", (req, res) => {
    const wtPath = typeof req.body?.path === "string" ? req.body.path : "";
    if (!wtPath) { res.status(400).json({ error: "path required" }); return; }
    const reposRoot = path.join(os.homedir(), ".rotom", "repos");
    const resolved = path.resolve(wtPath);
    if (!resolved.startsWith(reposRoot + path.sep)) {
      res.status(403).json({ error: "path must be under ~/.rotom/repos/" });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.json({ ok: true, note: "already gone" });
      return;
    }
    // 找 bare clone(worktree 的 gitdir 指向它),用 git worktree remove
    const gitdirFile = path.join(resolved, ".git");
    let barePath: string | null = null;
    try {
      if (fs.existsSync(gitdirFile)) {
        const content = fs.readFileSync(gitdirFile, "utf-8").trim();
        const m = content.match(/^gitdir:\s*(.+)$/);
        if (m) {
          // m[1] 形如 /Users/.../repos/<repo>.git/worktrees/<slot>
          // bare 是 .../repos/<repo>.git
          const wtMeta = path.resolve(resolved, m[1]);
          barePath = path.resolve(wtMeta, "../.."); // 上两级到 .git
        }
      }
    } catch { /* ignore */ }
    if (barePath && fs.existsSync(barePath)) {
      try {
        const r = spawnSync("git", ["worktree", "remove", "--force", resolved], { cwd: barePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
        if (r.status !== 0) {
          // git 拒绝(可能 worktree 有改动),兜底物理删
          fs.rmSync(resolved, { recursive: true, force: true });
          spawnSync("git", ["worktree", "prune"], { cwd: barePath });
        }
      } catch {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    } else {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    log.info(`Worktree removed: ${resolved}`);
    res.json({ ok: true });
  });
}

// ── handleAskRequest —— POST /asks 与 federation createBridgeForRoute 共用的核心 ─
//
// 在协调 master 本地建/复用 a2a_direct pair 群 + 写 asker 提问 + 建 ask-bridge。
// 返回 { bridgeId, groupId };由调用方决定后续行为:
//   - POST /asks 本地路径:调 sendAsAgent dispatch + sync 模式阻塞轮询 / async 立即返回
//   - federation createBridgeForRoute:不调 sendAsAgent(目标在远程,由 forwardDeliver 路由),
//     reply 到达时由 onBridgeReply 写群+resolve bridge
//
// 注:本地路径下,asker 在本机注册,target 也在本机注册;sendAsAgent 走 a2a_direct 静默分支
// (conversation.ts:271-282),needReply=true 触发 target dispatch,不广播。
//
// 返回 null 表示出错(error 字符串在 .error),否则返回 { bridgeId, groupId, questionMsgId }。

interface AskRequestInput {
  db: MeshDb;
  hub: WSHub;
  asker: string;
  target: string;
  message: string;
  mode: "sync" | "async";
  timeoutMs: number;
  escalateTo: string | null;
  /** 不调 sendAsAgent,只入库消息(用于 federation 路径,目标在远程)。默认 false。 */
  skipDispatch?: boolean;
}

interface AskRequestResult {
  error?: string;
  bridgeId?: string;
  groupId?: string;
  questionMsgId?: number;
}

export function handleAskRequest(input: AskRequestInput): AskRequestResult {
  const { db, hub, asker, target, message, mode, timeoutMs, escalateTo, skipDispatch } = input;
  const askerAgent = db.getAgentByName(asker);
  if (!askerAgent) return { error: `Asker agent "${asker}" not found` };
  const targetAgent = db.getAgentByName(target);
  if (!targetAgent && !skipDispatch) return { error: `Target agent "${target}" not found` };

  // 1. 找/建 a2a_direct pair 群(3 天 TTL 续命)
  let group = db.findActivePairGroup(asker, target);
  if (!group) group = db.createPairGroup(asker, target);

  // 2. 写 asker 提问进群
  let questionMsgId: number;
  if (skipDispatch) {
    // federation 路径:目标在远程,sendAsAgent 找不到 target agent → 直接入库
    const mentionTag = `@${target}`;
    const messageBody = message.startsWith(mentionTag) ? message : `${mentionTag} ${message}`;
    questionMsgId = db.addGroupMessage(group.id, asker, messageBody, [target]);
    db.bumpGroupActivity(group.id);
  } else {
    // 本地路径:调 sendAsAgent 走 a2a_direct 静默分支,触发 target dispatch
    const sendResult = hub.sendAsAgent({
      fromName: asker,
      target,
      message,
      groupId: group.id,
      groupName: group.name,
      needReply: true,
    });
    if (sendResult.error) return { error: sendResult.error };
    questionMsgId = sendResult.messageId!;
    // sendAsAgent 内部已调 addGroupMessage + bumpGroupActivity + autoCreateBridgeOnMention 等
  }

  // 3. 建 ask-bridge
  const bridgeId = randomUUID();
  db.createAskBridge({
    id: bridgeId,
    groupId: group.id,
    asker,
    target,
    questionMsgId,
    escalateTo,
    timeoutMs,
    mode,
  });

  // 4. 起 ask-bridge-check 定时任务(20s interval,scheduler 跑 reply 检测兜底)
  db.createScheduledTask({
    name: `星期五 · 等待 ${target} 回复`,
    groupId: group.id,
    mode: "message",
    scheduleKind: "interval",
    intervalSec: 20,
    prompt: `星期五 每 20s 检查一次 ${target} 有没有回复 ${asker} 的问题;有回复就 resolve bridge,5 分钟 sync 模式不升级、async 模式升级 Issue。`,
    handlerKey: "ask-bridge-check",
    handlerPayload: JSON.stringify({ bridgeId, asker, target, mode }),
  });

  log.info(`[api/asks] bridge created: bridge=${bridgeId} group=${group.id} (${asker}→${target}, mode=${mode})`);
  return { bridgeId, groupId: group.id, questionMsgId };
}
