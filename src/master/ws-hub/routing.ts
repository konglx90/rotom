/**
 * Routing — send/broadcast primitives and issue-coordination pushes.
 *
 * Lower-level transport helpers (send / sendToAgent / broadcastToGroup) plus
 * the issue-system notifications (assignment / approval / chat cancel /
 * continue / append / new issue / change). All of these are pure routing —
 * no message-handler logic lives here. Methods attach via Object.assign.
 */

import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.js";
import { normalizeApprovalPolicy, type WSHubSelf } from "./hub.js";
import { enrichWorkerDispatch } from "./dispatch-enrich.js";

export const routingMethods = {
  // ─────────────────────────────────────────────────────────────────────────
  // Low-level transport
  // ─────────────────────────────────────────────────────────────────────────

  /** Send a message to a connected agent. Returns false if not connected. */
  sendToAgent(this: WSHubSelf, agentId: string, msg: ServerMessage): boolean {
    const conn = this.connections.get(agentId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    this.send(conn.ws, msg);
    return true;
  },

  /** Lowest-level transport: serialize + ws.send. Public since connection,
   *  directory, and conversation modules all need to push directly. */
  send(this: WSHubSelf, ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  },

  /**
   * Broadcast a message to all group members EXCEPT those in excludeAgentIds.
   * Used for group message visibility — messages/replies are broadcast so all
   * group members see them in real-time.
   */
  broadcastToGroup(
    this: WSHubSelf,
    groupId: string,
    msg: ServerMessage,
    excludeAgentIds: string[] = [],
  ): void {
    const members = this.db.getGroupMembers(groupId);
    const delivered: { name: string; sent: boolean }[] = [];
    for (const member of members) {
      const memberAgent = this.db.getAgentByName(member.agent_name);
      if (!memberAgent) continue;
      if (excludeAgentIds.includes(memberAgent.id)) continue;
      const ok = this.sendToAgent(memberAgent.id, msg);
      delivered.push({ name: member.agent_name, sent: ok });
    }
    // 流式 chunk 广播会每 chunk 调一次,记日志只会刷屏,跳过;其他类型
    // （a2a_send 等）的广播日志保留,方便排查投递问题。
    const isStreamingChunk = msg.type === "a2a_stream_chunk";
    if (!isStreamingChunk) {
      this.logger.info(`[mesh] broadcastToGroup ${groupId}: ${delivered.length} members, results=${JSON.stringify(delivered)}`);
    }
  },

  /**
   * Public entry point for broadcasting a group message from outside the hub
   * (e.g. REST handlers in api/groups.ts). Thin wrapper over the private
   * broadcastToGroup — keeps the internal helper encapsulated.
   */
  broadcastToGroupPublic(
    this: WSHubSelf,
    groupId: string,
    msg: ServerMessage,
    excludeAgentIds: string[] = [],
  ): void {
    this.broadcastToGroup(groupId, msg, excludeAgentIds);
  },

  /**
   * 发一条 sender=system 的群消息:入库 + 实时广播给在线群成员。
   * 用于协作流转类消息(启动 / 进入下一轮 / 结束),让群里所有人同步看到状态。
   * - excludeAgentNames:不往这些成员的 WS 推,但消息仍然入库。用于避免 @ 的对象被双触发。
   * - ensureRecipientNames:保证这些 agent 能收到(即便它不在群成员里)。
   *   用于 mention 了非群成员(如协作 firstParticipant 不在群里)的场景。
   */
  postSystemToGroup(
    this: WSHubSelf,
    groupId: string,
    content: string,
    excludeAgentNames: string[] = [],
    ensureRecipientNames: string[] = [],
  ): void {
    this.logger.info(`[mesh] postSystemToGroup groupId=${groupId} exclude=${JSON.stringify(excludeAgentNames)} ensure=${JSON.stringify(ensureRecipientNames)}`);
    const mentions = content.match(/@([\w一-鿿][\w.一-鿿-]*)/g)?.map((m) => m.slice(1)) || [];
    this.db.addGroupMessage(groupId, "system", content, mentions);

    const excludeAgentIds = excludeAgentNames
      .map((name) => this.db.getAgentByName(name)?.id)
      .filter((id): id is string => !!id);

    const wireMsg: ServerMessage = {
      type: "a2a_message",
      requestId: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: { name: "system", status: "online" },
      payload: { message: content },
      routeType: "exact",
      conversation: { type: "group", groupId },
    };

    // 1) 推给群成员
    this.broadcastToGroup(groupId, wireMsg, excludeAgentIds);

    // 2) 保证这些 recipient 收到(即便它不在群里);与 broadcast 去重
    const memberNames = new Set(this.db.getGroupMembers(groupId).map((m) => m.agent_name));
    for (const name of ensureRecipientNames) {
      if (excludeAgentNames.includes(name)) continue;
      if (memberNames.has(name)) continue; // already covered by broadcastToGroup
      const agent = this.db.getAgentByName(name);
      if (!agent) {
        this.logger.warn(`[mesh] postSystemToGroup: ensure recipient "${name}" not registered`);
        continue;
      }
      const ok = this.sendToAgent(agent.id, wireMsg);
      this.logger.info(`[mesh] postSystemToGroup ensure delivery → ${name}: sent=${ok}`);
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Issue system (task coordination)
  // ─────────────────────────────────────────────────────────────────────────

  /** Push issue assignment notification to a specific executor agent. */
  pushIssueAssignment(this: WSHubSelf, issueId: string, agentName: string): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue) return false;
    const agent = this.db.getAgentByName(agentName);
    if (!agent) return false;
    return this.sendToAgent(agent.id, enrichWorkerDispatch(this, {
      type: "issue_assigned",
      issueId: issue.id,
      groupId: issue.group_id,
      title: issue.title,
      description: issue.description,
      workingDir: issue.working_dir || undefined,
      slashCommand: issue.slash_command || undefined,
      approvalPolicy: normalizeApprovalPolicy(issue.approval_policy),
    } as ServerMessage, agentName, issue.group_id));
  },

  /**
   * Push the user's approval decision to the worker that owns the parked
   * codex JSON-RPC request. Returns false when the issue has no assignee or
   * the assignee is offline (REST layer should still record the decision so
   * it sticks once the agent reconnects).
   */
  pushApprovalResponse(
    this: WSHubSelf,
    issueId: string,
    approvalId: string,
    decision: "accept" | "deny",
    feedback?: string,
  ): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue?.assigned_to) return false;
    const agent = this.db.getAgentByName(issue.assigned_to);
    if (!agent) return false;
    return this.sendToAgent(agent.id, {
      type: "issue_approval_response",
      issueId,
      approvalId,
      decision,
      ...(decision === "deny" && feedback ? { feedback } : {}),
    });
  },

  /**
   * Push a chat-stream cancellation to the responder worker. The responder
   * is the agent currently generating a reply (the dashboard knows its name
   * from the streaming bubble's `from` field). Returns false when the agent
   * is unknown or offline — in that case the stream is already broken (WS
   * disconnect killed the subprocess via existing cleanup paths), so the
   * HTTP caller can no-op.
   *
   * Worker-side: looks up `activeTasks["chat:" + requestId]`, flips aborted,
   * and calls controller.abort() so the CLI executor kills its subprocess.
   * If the task already completed naturally before this arrives, the worker
   * logs "no active task" and returns — idempotent.
   */
  pushChatCancel(this: WSHubSelf, agentName: string, requestId: string, reason?: string): boolean {
    const agent = this.db.getAgentByName(agentName);
    if (!agent) return false;
    return this.sendToAgent(agent.id, {
      type: "chat_cancelled",
      requestId,
      agentName,
      ...(reason ? { reason } : {}),
    });
  },

  /**
   * Push a user-supplied follow-up prompt to the assigned worker so it can
   * spawn its CLI with `--resume <sessionId>` (or start fresh when sessionId
   * is missing) and continue the conversation. Returns false when the issue
   * has no assignee or the assignee is offline.
   */
  pushIssueContinue(this: WSHubSelf, issueId: string, prompt: string): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue?.assigned_to) return false;
    const agent = this.db.getAgentByName(issue.assigned_to);
    if (!agent) return false;
    return this.sendToAgent(agent.id, enrichWorkerDispatch(this, {
      type: "issue_continue",
      issueId,
      groupId: issue.group_id,
      title: issue.title,
      prompt,
      sessionId: issue.session_id || undefined,
      workingDir: issue.working_dir || undefined,
      slashCommand: issue.slash_command || undefined,
      approvalPolicy: normalizeApprovalPolicy(issue.approval_policy),
    } as ServerMessage, issue.assigned_to, issue.group_id));
  },

  /**
   * Push an append-while-active prompt. Worker queues it onto the running
   * task and consumes the queue when the current CLI invocation finishes
   * (continuing with --resume <sessionId> if one is available). Distinct
   * from pushIssueContinue, which the master only fires AFTER the issue
   * has reached completed/failed.
   */
  pushIssueAppend(this: WSHubSelf, issueId: string, prompt: string): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue?.assigned_to) return false;
    const agent = this.db.getAgentByName(issue.assigned_to);
    if (!agent) return false;
    return this.sendToAgent(agent.id, enrichWorkerDispatch(this, {
      type: "issue_append",
      issueId,
      groupId: issue.group_id,
      title: issue.title,
      prompt,
      sessionId: issue.session_id || undefined,
      workingDir: issue.working_dir || undefined,
      slashCommand: issue.slash_command || undefined,
      approvalPolicy: normalizeApprovalPolicy(issue.approval_policy),
    } as ServerMessage, issue.assigned_to, issue.group_id));
  },

  /** Broadcast to all connected agents that a new issue is available. */
  notifyNewIssue(this: WSHubSelf, issueId: string, groupId: string, title: string, createdBy: string): void {
    const msg = {
      type: "issue_created" as const,
      issueId, groupId, title, createdBy,
    };
    for (const conn of this.connections.values()) {
      this.send(conn.ws, msg);
    }
  },

  /**
   * Notify the issue's group of a change so dashboards can refresh without
   * polling. Safe to call after any DB write touching the issue.
   */
  notifyIssueChanged(
    this: WSHubSelf,
    issueId: string,
    groupId: string,
    kind: "created" | "updated" | "event_appended" | "deleted",
  ): void {
    if (!groupId) return;
    this.broadcastToGroup(groupId, { type: "issue_changed", issueId, groupId, kind });
  },

  /**
   * Add this agentId to the issue's subscriber set. Idempotent — re-subscribe
   * on reconnect is safe. Used by dashboard clients to opt into
   * issue_usage_progress pushes for the issue they're viewing.
   */
  subscribeIssue(this: WSHubSelf, issueId: string, agentId: string): void {
    let set = this.issueSubscriptions.get(issueId);
    if (!set) {
      set = new Set();
      this.issueSubscriptions.set(issueId, set);
    }
    set.add(agentId);
  },

  /** Remove this agentId from the issue's subscriber set (no-op if absent). */
  unsubscribeIssue(this: WSHubSelf, issueId: string, agentId: string): void {
    const set = this.issueSubscriptions.get(issueId);
    if (!set) return;
    set.delete(agentId);
    if (set.size === 0) this.issueSubscriptions.delete(issueId);
  },

  /**
   * Remove this agentId from ALL issue subscriptions. Called on disconnect /
   * "Replaced by new connection" to prevent pushes to dead sockets. Iterating
   * a snapshot via Array.from avoids mutating-during-iteration if cleanup
   * deletes the Set (which would also delete the Map entry).
   */
  unsubscribeAllIssues(this: WSHubSelf, agentId: string): void {
    for (const issueId of Array.from(this.issueSubscriptions.keys())) {
      this.unsubscribeIssue(issueId, agentId);
    }
  },

  /**
   * Push a ServerMessage to every agent currently subscribed to the issue.
   * Used for issue_usage_progress — explicitly NOT a broadcast, since usage
   * pushes are high-frequency (1Hz during execution) and only the client
   * viewing that issue's detail cares.
   */
  sendToIssueSubscribers(this: WSHubSelf, issueId: string, msg: ServerMessage): void {
    const set = this.issueSubscriptions.get(issueId);
    if (!set || set.size === 0) return;
    for (const agentId of set) {
      this.sendToAgent(agentId, msg);
    }
  },
};