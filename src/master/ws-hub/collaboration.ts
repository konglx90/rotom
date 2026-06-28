/**
 * Collaboration — multi-agent round tracking + conversation enrichment.
 *
 * `enrichConversationWithCollaboration` attaches workingDir / activeIssues /
 * collaboration metadata to outgoing conversation payloads so agents and
 * dashboards see what the group is doing. Called from the connection
 * handler's a2a_send / a2a_reply / a2a_reply_end paths.
 *
 * `trackCollaborationTurn` records a group message as a turn in the active
 * collaboration. When the round is complete it either advances to the next
 * round or calls `concludeCollaboration` to generate a summary.
 *
 * `sendAsAgent` is the HTTP-side mirror of `a2a_send` — used by REST
 * handlers (CLI, dashboard API) to send messages on behalf of an agent.
 *
 * Methods attach via Object.assign.
 */

import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../../shared/protocol.js";
import type { WSHubSelf } from "./hub.js";
import { enrichWorkerDispatch } from "./dispatch-enrich.js";

export const collaborationMethods = {
  /**
   * If the conversation targets a group with an active collaboration, return a
   * cloned conversation with `collaboration` metadata attached. Returns the
   * original otherwise.
   *
   * `targetAgentName` 让 workingDir 走成员级 override 优先:dashboard 在
   * MemberListModal 里设的 per-(group, agent) working_dir 写到了
   * group_member_settings,必须在这里查出来才能透传给前端展示。
   *
   * 注意:`workingDir` 仅用于 dashboard 展示/解析,**不会**被 executor 当作
   * spawn cwd —— 后者必须走本机 `resolveIssueCwd` 派生(见 worker.ts
   * "跨机器部署安全"注释),否则多机部署下会把 master 本地路径推给别的机器。
   */
  enrichConversationWithCollaboration<T extends { type?: string; groupId?: string } | undefined>(
    this: WSHubSelf,
    conversation: T,
    targetAgentName?: string,
  ): T {
    if (!conversation || !conversation.groupId) return conversation;

    // workingDir 优先级:成员级 override > 群级默认。仅作为元数据透传给前端,
    // executor 不会消费(避免跨机器把 master 本地路径推到非 master executor)。
    const memberOverride = targetAgentName
      ? this.db.getGroupMemberSetting(conversation.groupId, targetAgentName)
      : null;
    const group = this.db.getGroupById(conversation.groupId);
    const workingDir = memberOverride || group?.working_dir || undefined;

    if (conversation.type !== "group") {
      // DM / single chat — only workingDir enrichment is meaningful.
      return workingDir ? ({ ...conversation, workingDir } as T) : conversation;
    }

    // Active task issues (non-collaboration) for the group — used by agents to
    // decide whether file writes are permitted. Cap at 8 to keep prompt small.
    const openIssues = this.db
      .listIssuesByGroup(conversation.groupId, "open", "task")
      .slice(0, 8);
    const inProgressIssues = this.db
      .listIssuesByGroup(conversation.groupId, "in_progress", "task")
      .slice(0, 8);
    const activeIssues = [...inProgressIssues, ...openIssues].slice(0, 8).map((it) => ({
      id: it.id,
      title: it.title,
      status: it.status,
      assignedTo: it.assigned_to || undefined,
      priority: it.priority || undefined,
    }));

    const collabs = this.db.getActiveCollaborationsByGroup(conversation.groupId);
    if (collabs.length === 0) {
      // No collaboration but still attach activeIssues so agents can see them.
      return { ...conversation, activeIssues, workingDir, guidancePrompt: group?.guidance_prompt || undefined } as T;
    }
    const collab = collabs[0]; // single active collaboration per group
    const currentRound = collab.current_round ?? 1;
    const { lastRoundTurns, earlierSpeakers } = this.db.buildCollaborationContext(collab.id, currentRound);
    const participants: string[] = (() => {
      try { return JSON.parse(collab.participants || "[]"); } catch { return []; }
    })();
    return {
      ...conversation,
      activeIssues,
      workingDir,
      guidancePrompt: group?.guidance_prompt || undefined,
      collaboration: {
        issueId: collab.id,
        title: collab.title,
        goal: collab.collaboration_goal || "",
        participants,
        currentRound,
        maxRounds: collab.max_rounds ?? 1,
        owner: collab.owner || undefined,
        lastRoundTurns,
        earlierSpeakers,
      },
    } as T;
  },

  /**
   * 隐式 bridge 创建:群消息落库后调。若 sender @ 了某 agent B,自动建 bridge
   * (asker=sender, target=B) + 20s interval scheduled_task。A 不用调 rotom ask,
   * 直接 @ B 即可,系统透明管 timer。
   *
   * 跳过条件:
   *   - B == sender(自 @)
   *   - B 是真人(category=真人,真人不参与 bridge)
   *   - sender 是某 pending bridge 的 target(说明 sender 在回复别人问题,不是在提问)
   *   - (sender, B) 已有 pending bridge(防重)
   */
  autoCreateBridgeOnMention(this: WSHubSelf, groupId: string, sender: string, mentions: string[], msgId: number): void {
    if (mentions.length === 0 || sender === "system") return;
    // 只有消息含 #reply 标记才建 bridge——普通 @ 不需要回复,不建 timer
    const content = this.db.getGroupMessageContent(msgId) || "";
    if (!content.includes("#reply")) return;
    const senderAgent = this.db.getAgentByName(sender);
    if (!senderAgent) return;
    for (const targetName of mentions) {
      if (targetName === sender) continue;
      const targetAgent = this.db.getAgentByName(targetName);
      if (!targetAgent) continue;
      // 跳过真人 target
      let targetProfile: any = {};
      try { targetProfile = targetAgent.profile ? JSON.parse(targetAgent.profile) : {}; } catch { /* ignore */ }
      if (targetProfile.category === "真人") continue;
      // 跳过:sender 是某 pending bridge 的 target(在回复,不在提问)
      const asTarget = this.db.findPendingBridge(groupId, targetName, sender);
      if (asTarget) continue;
      // 跳过:已有 pending bridge (sender → targetName)
      const existing = this.db.findPendingBridge(groupId, sender, targetName);
      if (existing) continue;
      // 建 bridge
      const bridgeId = randomUUID();
      const bridge = this.db.createAskBridge({
        id: bridgeId,
        groupId,
        asker: sender,
        target: targetName,
        questionMsgId: msgId,
        escalateTo: null,
        timeoutMs: 5 * 60_000,
      });
      const task = this.db.createScheduledTask({
        name: `ask-bridge:${bridgeId.slice(0, 8)}`,
        groupId,
        mode: "message",
        scheduleKind: "interval",
        intervalSec: 20,
        prompt: `(ask-bridge timer for ${bridgeId})`,
        handlerKey: "ask-bridge-check",
        handlerPayload: JSON.stringify({ bridgeId }),
      });
      this.logger.info(`[mesh] bridge auto-created: ${bridgeId} (${sender}→${targetName}) msg=${msgId} (#reply), schedule task #${task.id}`);
    }
  },

  /**
   * 事件式 bridge 检测:群消息落库后调。若该消息"答中"了某 pending bridge
   * (sender = bridge.target AND mentions 含 bridge.asker),mark answered + disable
   * scheduled_task + **注入 system @ 消息给 asker**(带"汇报给原始提问者"上下文)。
   *
   * 不直接 WS 推 raw @ —— 那样 A 的 LLM 会回复给 B 而非汇报给原始提问者。
   * 改用 postSystemToGroup 注入带上下文的 system 消息,A 的 LLM 知道该汇报给谁。
   */
  checkAndCancelBridgesForMessage(this: WSHubSelf, groupId: string, sender: string, mentions: string[], msgId: number): void {
    if (mentions.length === 0) return;
    const bridges = this.db.findBridgesAnsweredByMessage(groupId, sender, mentions);
    if (bridges.length === 0) return;
    // B @ A 回复:A 通过 a2a_message 广播已收到(session 复用,有上下文)。
    // 这里只 cancel bridge + delete timer,不注入 system 消息——避免 A 收到两条消息(raw @ + system)顺序不确定。
    // system 复述只在 handler 路径(非@回复,20s poll 检测)走,A 没被 @ 触发才需要 system 唤醒。
    for (const bridge of bridges) {
      this.db.markBridgeAnswered(bridge.id, msgId);
      const taskName = `ask-bridge:${bridge.id.slice(0, 8)}`;
      const task = this.db.findScheduledTaskByName(taskName);
      if (task && task.enabled) {
        this.db.disableScheduledTask(task.id);
      }
      this.logger.info(`[mesh] bridge ${bridge.id} auto-answered: ${sender} @ ${bridge.asker} (msg ${msgId}), timer "${taskName}" cancelled`);
    }
  },

  /** Track a group message as a collaboration turn if applicable. */
  trackCollaborationTurn(this: WSHubSelf, groupId: string, agentName: string, content?: string): void {
    // Find active collaborations in this group
    const collaborations = this.db.getActiveCollaborationsByGroup(groupId);
    if (collaborations.length === 0) return;

    for (const collab of collaborations) {
      const participants: string[] = JSON.parse(collab.participants || "[]");
      if (!participants.includes(agentName)) continue;

      const currentRound = collab.current_round ?? 1;

      // Skip if agent already contributed this round
      if (this.db.hasAgentContributedThisRound(collab.id, agentName, currentRound)) continue;

      // Record the contribution
      this.db.recordCollaborationTurn(collab.id, agentName, currentRound, content);
      this.logger.info(`[mesh] Collaboration turn: ${agentName} in round ${currentRound} of "${collab.title}" (${collab.id})`);
      this.notifyIssueChanged(collab.id, groupId, "event_appended");

      // Check if the round is complete
      if (this.db.isRoundComplete(collab.id, currentRound)) {
        const maxRounds = collab.max_rounds ?? 1;
        if (currentRound >= maxRounds) {
          // Collaboration complete — generate summary
          this.concludeCollaboration({
            id: collab.id,
            title: collab.title,
            group_id: collab.group_id,
            max_rounds: collab.max_rounds,
            owner: collab.owner,
          }, participants);
        } else {
          // Advance to next round
          this.db.advanceCollaborationRound(collab.id, participants);
          const nextRound = currentRound + 1;

          // 协作式:不再主动广播 collaboration_started 给所有参与者;
          // 由最近发言的 agent 通过 @ 显式选择下一个发言人。
          this.postSystemToGroup(groupId, `🔁 [协作进展] 协作任务「${collab.title}」进入第 ${nextRound}/${maxRounds} 轮,等待当前发言人 @ 下一位或主动结束。`);
          this.notifyIssueChanged(collab.id, groupId, "updated");

          this.logger.info(`[mesh] Collaboration "${collab.title}" advanced to round ${nextRound}`);
        }
      }
    }
  },

  /** Conclude a collaboration by generating a summary from all turns. */
  concludeCollaboration(
    this: WSHubSelf,
    collab: { id: string; title: string; group_id: string; max_rounds: number | null; owner: string | null },
    participants: string[],
  ): void {
    const events = this.db.getIssueEvents(collab.id);
    const turnEvents = events.filter((e) => e.event_type === "collaboration_turn");

    // Build a simple summary from the collected turns
    const turnSummary = turnEvents.map((e) => `${e.agent_name}: ${e.content}`).join("\n");
    const summary = `协作任务「${collab.title}」已完成,共 ${collab.max_rounds ?? 0} 轮。\n\n参与者的贡献:\n\n${turnSummary}`;

    this.db.completeCollaboration(collab.id, summary);

    // Broadcast conclusion to all participants
    const conclusionMsg = {
      type: "collaboration_concluded" as const,
      issueId: collab.id,
      groupId: collab.group_id,
      title: collab.title,
      summary,
      totalRounds: collab.max_rounds ?? 0,
      owner: collab.owner || undefined,
    };

    for (const participant of participants) {
      const agent = this.db.getAgentByName(participant);
      if (agent) {
        this.sendToAgent(agent.id, conclusionMsg);
      }
    }

    // Post system message to group
    const ownerLine = collab.owner ? `负责人:${collab.owner}` : "无负责人";
    this.postSystemToGroup(collab.group_id, `🏁 [协作完成] 协作任务「${collab.title}」已完成,共 ${collab.max_rounds ?? 0} 轮协作。${ownerLine}`);
    this.notifyIssueChanged(collab.id, collab.group_id, "updated");

    this.logger.info(`[mesh] Collaboration concluded: "${collab.title}" (${collab.id})`);
  },

  /**
   * Send a message on behalf of an agent, mirroring the WS `a2a_send` path
   * for HTTP/CLI callers. If `groupId` is provided the message is treated as
   * a group message: routed to `target` and recorded in group history.
   */
  sendAsAgent(this: WSHubSelf, opts: {
    fromName: string;
    target: string;
    message: string;
    groupId?: string;
    groupName?: string;
  }): { requestId: string; delivered: boolean; queued: boolean; error?: string; messageId?: number } {
    const fromAgent = this.db.getAgentByName(opts.fromName);
    if (!fromAgent) return { requestId: "", delivered: false, queued: false, error: `Sender agent "${opts.fromName}" not found` };
    const targetAgent = this.db.getAgentByName(opts.target);
    if (!targetAgent) return { requestId: "", delivered: false, queued: false, error: `Target agent "${opts.target}" not found` };

    const requestId = `cli_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const conversation = opts.groupId
      ? { type: "group" as const, groupId: opts.groupId, groupName: opts.groupName }
      : undefined;

    const result = this.router.route(fromAgent.id, {
      requestId,
      target: opts.target,
      payload: { message: opts.message },
      ...(conversation ? { conversation } : {}),
    } as Parameters<typeof this.router.route>[1]);

    if (result.error) return { requestId, delivered: false, queued: false, error: result.error };

    let delivered = false;
    let queued = false;
    let messageId: number | undefined;
    if (result.targetAgentId) {
      const enrichedConversation = this.enrichConversationWithCollaboration(conversation);
      const wireMsg = enrichWorkerDispatch(this, {
        type: "a2a_message" as const,
        requestId,
        from: { name: opts.fromName, domain: fromAgent.domain || undefined, status: "online" as const },
        payload: { message: opts.message },
        routeType: "exact" as const,
        conversation: enrichedConversation,
      } as ServerMessage, result.targetName, enrichedConversation?.groupId);
      delivered = this.sendToAgent(result.targetAgentId, wireMsg);

      if (opts.groupId) {
        // 兜底:发信人不在 group_members 时自动 addMembers(防"自激丢消息" +
        // "多 tab 真人看不到自己的消息")。INSERT OR IGNORE 幂等。
        const groupMembers = this.db.getGroupMembers(opts.groupId);
        if (!groupMembers.some((m) => m.agent_name === opts.fromName)) {
          this.db.addGroupMembers(opts.groupId, [opts.fromName]);
          this.logger.info(`[mesh] sendAsAgent group: auto-joined sender "${opts.fromName}" as group member`);
        }

        // 群消息:除打给 target 外广播给全群(对齐 a2a_reply L462-465)。
        // 排除列表含 target 防重复推送。同时排除所有 @mentioned agent 防
        // Dashboard 多次发送 a2a_send 导致的广播重复投递。
        const sendAsMentions = opts.message.match(/@([\w一-鿿][\w.一-鿿-]*)/g)?.map((m: string) => m.slice(1)) || [];
        const sendAsMentionAgentIds = sendAsMentions
          .map((name: string) => this.db.getAgentByName(name)?.id)
          .filter((id: string | undefined): id is string => !!id);
        this.broadcastToGroup(opts.groupId, wireMsg, [fromAgent.id, result.targetAgentId, ...sendAsMentionAgentIds]);

        const mentions = sendAsMentions;
        messageId = this.db.addGroupMessage(opts.groupId, opts.fromName, opts.message, mentions);
        this.trackCollaborationTurn(opts.groupId, opts.fromName, opts.message);
        this.autoCreateBridgeOnMention(opts.groupId, opts.fromName, mentions, messageId);
        this.checkAndCancelBridgesForMessage(opts.groupId, opts.fromName, mentions, messageId);
      }

      if (!delivered) {
        queued = this.offlineQueue.enqueue(
          result.targetAgentId, opts.fromName, fromAgent.domain || undefined,
          { message: opts.message }, "exact",
        );
      }
    }

    this.db.logMessage({
      requestId,
      fromName: opts.fromName,
      fromDomain: fromAgent.domain || undefined,
      toName: result.targetName,
      toDomain: result.targetAgentId ? this.db.getAgentById(result.targetAgentId)?.domain ?? undefined : undefined,
      routeType: "exact",
      direction: "send",
      payload: JSON.stringify({ message: opts.message }),
      status: queued ? "queued" : delivered ? "routed" : "no_target",
      groupId: opts.groupId,
      source: "cli",
    });

    return { requestId, delivered, queued, messageId };
  },
};