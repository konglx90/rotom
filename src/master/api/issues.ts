import { type Router as ExpressRouter } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import { parseSlashCommand } from "../../shared/slash-commands.js";
import { ISSUE_STATUSES } from "../../shared/constants.js";
import { resolveGroupAgentWorkingDir } from "../group-paths.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("mesh-api");

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

export function registerIssueRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  _auth: unknown,
  hub?: WSHub,
): void {
  apiRouter.get("/issues", (req, res) => {
    const status = req.query.status as string | undefined;
    res.json(db.listAllIssues(status));
  });

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
    } else {
      // No explicit workingDir: resolve from per-(group, createdBy) override →
      // group.working_dir → default, mirroring PUT /issues/:id assignment logic.
      issueWorkDir = resolveGroupAgentWorkingDir(db, req.params.groupId, createdBy);
    }
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

  apiRouter.get("/issues/:id", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const events = db.getIssueEvents(req.params.id);
    res.json({ ...issue, events });
  });

  apiRouter.put("/issues/:id", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const { assignedTo, priority, title, description, approvalPolicy, status } = req.body;
    if (assignedTo !== undefined) {
      const normalized = (assignedTo === null || assignedTo === "") ? null : String(assignedTo);
      db.updateIssueStatus(req.params.id, issue.status, { assignedTo: normalized });
      db.addIssueEvent({
        issueId: req.params.id, eventType: "assigned",
        // agent_name 即被指派的 agent(dashboard chip 会显示);content 留空 →
        // 走 system chip 渲染,不再伪装成 agent 自己说"Assigned to me"。
        agentName: normalized || "system",
      });
      // Re-resolve working_dir from per-(group, agent) override → group.working_dir → default.
      if (normalized && (issue.status === "open" || issue.status === "in_progress")) {
        const resolved = resolveGroupAgentWorkingDir(db, issue.group_id, normalized);
        if (resolved !== issue.working_dir) {
          db.updateIssueWorkingDir(req.params.id, resolved);
          db.addIssueEvent({
            issueId: req.params.id, eventType: "working_dir_resolved",
            agentName: "system",
            content: `working_dir → ${resolved}`,
            metadata: { source: "assignment", assignee: normalized },
          });
          log.info(`Issue ${req.params.id} working_dir re-resolved to ${resolved} for assignee ${normalized}`);
        }
      }
    }
    if (priority !== undefined) {
      db.updateIssuePriority(req.params.id, priority);
    }
    if (title !== undefined || description !== undefined) {
      const fields: { title?: string; description?: string; slashCommand?: string | null } = {};
      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) {
          res.status(400).json({ error: "title cannot be empty" });
          return;
        }
        fields.title = t;
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
    if (status !== undefined) {
      if (!ISSUE_STATUSES.includes(status)) {
        res.status(400).json({ error: `status must be one of ${ISSUE_STATUSES.join("|")}` });
        return;
      }
      if (status !== issue.status) {
        db.updateIssueStatus(req.params.id, status);
        db.addIssueEvent({
          issueId: req.params.id, eventType: "status_changed",
          agentName: "system",
          content: `${issue.status} → ${status}`,
          metadata: { from: issue.status, to: status },
        });
      }
    }
    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    res.json({ ok: true });
  });

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

    if (hub && issue.group_id) {
      hub.postSystemToGroup(issue.group_id, `🚫 Issue 「${issue.title}」已被 ${cancelledBy} 取消`);
    }

    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    res.json({ ok: true });
  });

  // 中断当前步骤但保留 issue in_progress(对齐 codex CLI 的 ESC 行为)。
  // 与 /cancel 的区别:不翻转 status,session_id 保留,worker abort 后由
  // runIssueExecution 的 finally 块决定是否 --resume 续跑(pendingAppends
  // 非空时合并队列续跑,空则保持 idle 等用户下一次 append)。
  apiRouter.post("/issues/:id/interrupt", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.status !== "in_progress") {
      res.status(400).json({ error: `Cannot interrupt an issue in status "${issue.status}" (expected in_progress)` });
      return;
    }
    if (!issue.assigned_to) {
      res.status(400).json({ error: "Issue has no assignee — cannot interrupt" });
      return;
    }
    const agent = db.getAgentByName(issue.assigned_to);
    if (!agent) {
      res.status(400).json({ error: `Assignee "${issue.assigned_to}" is not a registered agent` });
      return;
    }
    if (agent.status !== "online") {
      res.status(409).json({ error: `Assignee "${issue.assigned_to}" is offline — nothing to interrupt` });
      return;
    }
    const interruptedBy = typeof req.body?.interruptedBy === "string" && req.body.interruptedBy
      ? req.body.interruptedBy
      : "dashboard-user";
    db.addIssueEvent({
      issueId: req.params.id,
      eventType: "interrupted",
      // agent_name 即谁触发中断(dashboard chip 显示);content 留空 →
      // 走 system chip,不再伪装成 agent 自己说"Interrupted by X"。
      agentName: interruptedBy,
    });
    const delivered = hub ? hub.sendToAgent(agent.id, {
      type: "issue_interrupt",
      issueId: req.params.id,
      groupId: issue.group_id,
    }) : false;
    log.info(`Issue ${req.params.id} interrupt → ${issue.assigned_to}: sent=${delivered}`);
    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "updated");
    res.json({ ok: true, delivered });
  });

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
      res.status(409).json({ error: `Assignee "${issue.assigned_to}" is offline — bring the worker online and retry` });
      return;
    }
    const continuedBy = typeof req.body?.continuedBy === "string" && req.body.continuedBy
      ? req.body.continuedBy
      : "dashboard-user";
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
      // agent_name 即 claim 的 worker;content 留空 → system chip,
      // 不再伪装成 agent 自己说"Claimed and started by me"。
      agentName,
    });
    if (hub) hub.notifyIssueChanged(issue.id, issue.group_id, "updated");
    res.json(issue);
  });

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

  apiRouter.get("/issues/:id/events", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(db.getIssueEvents(req.params.id));
  });

  apiRouter.get("/issues/:id/messages", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const messages = db.getIssueMessages(req.params.id);
    res.json(messages);
  });

  apiRouter.post("/issues/:id/comments", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const { agentName, content, replyTo } = req.body;
    if (!agentName || !content) {
      res.status(400).json({ error: "agentName and content are required" });
      return;
    }
    const agent = db.getAgentByName(agentName);
    if (!agent) {
      res.status(400).json({ error: `Agent \"${agentName}\" not found` });
      return;
    }
    // Validate replyTo if provided: must be an existing event on this issue
    if (replyTo !== undefined && replyTo !== null) {
      const target = db.getIssueEventById(replyTo);
      if (!target || target.issue_id !== req.params.id) {
        res.status(400).json({ error: `replyTo event ${replyTo} not found on this issue` });
        return;
      }
    }
    const eventId = db.addIssueComment(req.params.id, agentName, content, replyTo ?? undefined);
    if (hub) {
      hub.notifyIssueChanged(req.params.id, issue.group_id, "event_appended");
    }
    log.info(`Comment added to issue ${req.params.id} by ${agentName} (event=${eventId}, replyTo=${replyTo ?? "none"})`);
    res.status(201).json({ id: eventId, ok: true });
  });

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

  // ── Collaborations ──────────────────────────────────────────────────────

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
}
