import { type Router as ExpressRouter } from "express";
import { generateShortId } from "../../shared/short-id.js";
import type { MeshDb } from "../db.js";
import type { WSHub } from "../ws-hub.js";
import { parseSlashCommand } from "../../shared/slash-commands.js";
import { truncateTitle } from "../../shared/title.js";
import { ISSUE_STATUSES } from "../../shared/constants.js";
import { safeJsonParse } from "../../shared/parse.js";
import { validateWorkingDir } from "../util/paths.js";
import { buildMemoryExtractPrompt } from "../services/memory-extract-prompt.js";
import { resolveGroupAgentWorkingDir } from "../group-paths.js";
import { resolveGroupWorktreeInfo } from "../repo-scan.js";
import { createLogger } from "../../shared/logger.js";
import type { IssueRow } from "../db/types.js";
import type { TodoItem } from "../../shared/protocol.js";
import { nowBeijing } from "../../shared/time.js";

const log = createLogger("mesh-api");

/**
 * 解析 issue 应记录的 working_dir(展示/审计/artifacts 兜底用)。
 *
 * group 配了 repo_url 时,agent 真实 cwd 是 executor 在本机起的 worktree
 * (~/.rotom/artifacts/<groupId>/__repos/primary),这里记该计算路径(不依赖 FS
 * 是否已创建——issue 创建时 worktree 可能还没起),让 issue.working_dir 与 agent
 * 实际跑的目录一致,而非占位的产物目录。
 *
 * 无 repo 的 group 走老逻辑:per-(group, agent) override → group.working_dir → 默认。
 * executor 在 repoCtx 存在时本就忽略 workingDir override,故此值仅影响展示/兜底。
 */
function resolveIssueWorkingDirForDisplay(
  db: MeshDb,
  groupId: string,
  agentName: string,
): string {
  const wtInfo = resolveGroupWorktreeInfo(db, groupId);
  if (wtInfo) {
    // 用计算出的 primaryPath(过渡期可能指向旧路径,均可被 artifacts API 解析)
    return wtInfo.primaryPath;
  }
  return resolveGroupAgentWorkingDir(db, groupId, agentName);
}

/**
 * 在 DB 行上附 latest_todos 字段(解析后的 TodoItem[])。dashboard 直接消费
 * 这个字段渲染常驻面板;原 latest_todos_json 字段保留不动供审计 / 兼容。
 *
 * 解析失败(空字符串 / 非法 JSON)一律返回 undefined,dashboard 视作"未上报"。
 */
function withLatestTodos<T extends IssueRow>(row: T): T & { latest_todos?: TodoItem[] } {
  if (!row.latest_todos_json) return { ...row, latest_todos: undefined };
  try {
    const parsed = JSON.parse(row.latest_todos_json) as unknown;
    if (Array.isArray(parsed)) {
      const todos: TodoItem[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const content = typeof r.content === "string" ? r.content : "";
        if (!content) continue;
        const status: TodoItem["status"] =
          r.status === "in_progress" ? "in_progress" :
          r.status === "completed" ? "completed" :
          "pending";
        const activeForm = typeof r.activeForm === "string" && r.activeForm ? r.activeForm : undefined;
        todos.push({ content, status, ...(activeForm ? { activeForm } : {}) });
      }
      return { ...row, latest_todos: todos.length > 0 ? todos : undefined };
    }
  } catch { /* fall through */ }
  return { ...row, latest_todos: undefined };
}

export function registerIssueRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
  _auth: unknown,
  hub?: WSHub,
): void {
  apiRouter.get("/issues", (req, res) => {
    const status = req.query.status as string | undefined;
    // 分页:看板每列独立拉取首屏 50 条,completed/cancelled 累积过多时避免
    // 一次性把全表塞进 HTTP 响应。limit/offset 任一存在即返回 { items, total }
    // 包装;不带则保持旧行为(返回全量数组)以兼容未升级的调用方。
    const limitRaw = req.query.limit as string | undefined;
    const offsetRaw = req.query.offset as string | undefined;
    if (limitRaw !== undefined || offsetRaw !== undefined) {
      const limit = Math.max(1, Math.min(500, Number(limitRaw) || 50));
      const offset = Math.max(0, Number(offsetRaw) || 0);
      const page = db.listIssuesPage({ status, limit, offset });
      res.json({ items: page.items.map(withLatestTodos), total: page.total });
      return;
    }
    res.json(db.listAllIssues(status).map(withLatestTodos));
  });

  apiRouter.get("/groups/:groupId/issues", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const status = req.query.status as string | undefined;
    const type = req.query.type as string | undefined;
    res.json(db.listIssuesByGroup(req.params.groupId, status, type).map(withLatestTodos));
  });

  apiRouter.post("/groups/:groupId/issues", (req, res) => {
    const group = db.getGroupById(req.params.groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) { res.status(403).json({ error: "Group is archived, cannot create issues" }); return; }
    const { title, description, priority, createdBy, workingDir, approvalPolicy, repoUrl, repoBranch } = req.body;
    if (!createdBy) {
      res.status(400).json({ error: "createdBy is required" });
      return;
    }
    // 合并 title/description 后,title 可选:缺失时从 description 截断生成。
    // 这样前端/CLI 只需传一个内容字段,体验对齐 Claude Code 终端开箱即用。
    let finalTitle = (typeof title === "string" ? title : "").trim();
    const desc = (typeof description === "string" ? description : "").trim();
    if (!finalTitle) {
      if (!desc) {
        res.status(400).json({ error: "title or description is required" });
        return;
      }
      finalTitle = truncateTitle(desc);
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
    // group 配了 repo_url 时,issue 真正 cwd 由 executor 在本机起 worktree 后产生
    // (~/.rotom/artifacts/<groupId>/__repos/primary)。workingDir 字段不再由用户填,
    // 这里记 worktree 计算路径到 issues.working_dir(展示/审计/artifacts 兜底用);
    // executor 在 repoCtx 存在时本就忽略 workingDir override。
    const groupRepoUrl = group.repo_url?.trim();
    if (typeof workingDir === "string" && workingDir.trim() && !groupRepoUrl) {
      const v = validateWorkingDir(workingDir);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      issueWorkDir = v.path;
    } else if (groupRepoUrl) {
      // group 配了 repo:记真实 worktree 路径(与 agent 实际 cwd 一致)
      issueWorkDir = resolveIssueWorkingDirForDisplay(db, req.params.groupId, createdBy);
    } else {
      // No explicit workingDir 且 group 无 repo:走现状 per-(group, createdBy) override →
      // group.working_dir → default。
      issueWorkDir = resolveGroupAgentWorkingDir(db, req.params.groupId, createdBy);
    }
    let slashCommand: string | undefined;
    const parsed = parseSlashCommand(finalTitle);
    if (parsed?.known) {
      if (!parsed.stripped) {
        res.status(400).json({ error: `Slash command "${parsed.command}" 后必须跟任务正文` });
        return;
      }
      slashCommand = parsed.command;
    }
    const id = generateShortId();
    db.createIssue({
      id, groupId: req.params.groupId, title: finalTitle, description: desc,
      priority, createdBy, workingDir: issueWorkDir, slashCommand,
      approvalPolicy: normalizedApprovalPolicy,
      repoUrl: typeof repoUrl === "string" && repoUrl.trim() ? repoUrl.trim() : undefined,
      repoBranch: typeof repoBranch === "string" && repoBranch.trim() ? repoBranch.trim() : undefined,
    });
    log.info(`Issue created: "${finalTitle}" (${id}) in group ${req.params.groupId}`);
    if (hub) {
      hub.notifyIssueChanged(id, req.params.groupId, "created");
    }
    res.status(201).json({ id, title: finalTitle, status: "open" });
  });

  apiRouter.get("/issues/:id", (req, res) => {
    const issue = db.getIssueById(req.params.id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const events = db.getIssueEvents(req.params.id);
    res.json({ ...withLatestTodos(issue), events });
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
      // Re-resolve working_dir from worktree(repo 配置时)或 per-(group, agent) override。
      if (normalized && (issue.status === "open" || issue.status === "in_progress")) {
        const resolved = resolveIssueWorkingDirForDisplay(db, issue.group_id, normalized);
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
      const hasExplicitTitle = title !== undefined;
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
      // 合并 title/description 后:若未显式传 title 但传了 description,
      // title 从新 description 重新截断,保持二者同步。slash_command 也跟着重解析。
      if (!hasExplicitTitle && fields.description !== undefined) {
        const newTitle = truncateTitle(fields.description);
        if (newTitle && newTitle !== issue.title) {
          fields.title = newTitle;
          const parsed = parseSlashCommand(newTitle);
          fields.slashCommand = parsed?.known ? parsed.command : null;
        }
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
    if (issue.status !== "open" && issue.status !== "in_progress" && issue.status !== "paused") {
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
      metadata: { status: "queued", queuedAt: nowBeijing() },
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
    res.json(withLatestTodos(issue));
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
    const meta = safeJsonParse<Record<string, unknown>>(event.metadata, {});
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
    // 先通知 assignee 清理本机 worktree(若 repo 模式)。issue_cancelled 路径在
    // worker 端会 cleanupIssueWorktrees。DELETE 时 issue 还在 DB,能查到 assigned_to。
    if (hub && issue.assigned_to) {
      const agent = db.getAgentByName(issue.assigned_to);
      if (agent) {
        hub.sendToAgent(agent.id, {
          type: "issue_cancelled",
          issueId: req.params.id,
          groupId: issue.group_id,
          reason: `deleted`,
        });
      }
    }
    db.deleteIssue(req.params.id);
    if (hub) hub.notifyIssueChanged(req.params.id, issue.group_id, "deleted");
    res.json({ ok: true });
  });

  // ── Issue → 记忆提取(用户点「生成记忆」触发,非自动)──────────────────
  // 创建一个"记忆提取"任务 Issue,push 给指定 agent 执行。
  // agent 读原 Issue 产出 → 提炼记忆 → 调 `rotom memory add --pending` 写入。
  // 写入的记忆 pending_review=1,需用户在 MemoryPanel「待审核」tab 审核。
  apiRouter.post("/issues/:id/extract-memory", (req, res) => {
    const sourceIssue = db.getIssueById(req.params.id);
    if (!sourceIssue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (sourceIssue.status !== "completed") {
      res.status(400).json({ error: "只能对 completed 状态的 Issue 生成记忆" });
      return;
    }
    const { agentName } = req.body ?? {};
    const targetAgent = (typeof agentName === "string" && agentName.trim()) ? agentName.trim() : sourceIssue.assigned_to;
    if (!targetAgent) {
      res.status(400).json({ error: "原 Issue 无 assignee,需传 agentName 指定执行 agent" });
      return;
    }
    const targetAgentRow = db.getAgentByName(targetAgent);
    if (!targetAgentRow) {
      res.status(404).json({ error: `Agent "${targetAgent}" 不存在` });
      return;
    }
    if (!hub) {
      res.status(500).json({ error: "WSHub 未初始化" });
      return;
    }

    const sourceShortId = req.params.id.slice(0, 8);
    const extractIssueId = generateShortId();
    const extractPrompt = buildMemoryExtractPrompt(sourceIssue, sourceShortId);

    const workingDir = resolveIssueWorkingDirForDisplay(db, sourceIssue.group_id, targetAgent);
    db.createIssue({
      id: extractIssueId,
      groupId: sourceIssue.group_id,
      title: `[记忆提取] #${sourceShortId} ${sourceIssue.title}`.slice(0, 200),
      description: extractPrompt,
      createdBy: "system:memory-extract",
      workingDir,
      assignedTo: targetAgent,
      approvalPolicy: "rw_allow",
    });
    const pushed = hub.pushIssueAssignment(extractIssueId, targetAgent);
    if (!pushed) {
      log.warn(`extract-memory: pushIssueAssignment 失败,agent ${targetAgent} 可能不在线 (issue ${extractIssueId})`);
    }
    hub.notifyIssueChanged(extractIssueId, sourceIssue.group_id, "created");
    log.info(`extract-memory: source=${req.params.id} → extract issue=${extractIssueId} → agent=${targetAgent}`);
    res.status(201).json({ extractIssueId, agentName: targetAgent, pushed });
  });
}
