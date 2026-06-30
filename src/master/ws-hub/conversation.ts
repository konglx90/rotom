/**
 * Conversation enrichment + HTTP-side send + ask-bridge helpers.
 *
 * `enrichGroupConversation` attaches workingDir / activeIssues / memoryCounts /
 * skillCount / guidancePrompt to outgoing conversation payloads so agents and
 * dashboards see what the group is doing. Called from the connection handler's
 * a2a_send / a2a_reply / a2a_reply_end paths.
 *
 * `sendAsAgent` is the HTTP-side mirror of `a2a_send` — used by REST handlers
 * (CLI, dashboard API) to send messages on behalf of an agent.
 *
 * `autoCreateBridgeOnMention` / `checkAndCancelBridgesForMessage` drive the
 * implicit ask-bridge timer when agents @ each other with #reply.
 *
 * Methods attach via Object.assign.
 */

import { randomUUID } from "node:crypto";
import type { ServerMessage } from "../../shared/protocol.js";
import type { WSHubSelf } from "./hub.js";
import { enrichWorkerDispatch } from "./dispatch-enrich.js";
import { TIMER_PERSONA_NAME } from "../util/persona.js";

export const conversationMethods = {
  /**
   * Attach workingDir / activeIssues / memoryCounts / skillCount /
   * guidancePrompt to a conversation payload.
   *
   * `targetAgentName` 让 workingDir 走成员级 override 优先:dashboard 在
   * MemberListModal 里设的 per-(group, agent) working_dir 写到了
   * group_member_settings,必须在这里查出来才能透传给前端展示。
   *
   * 注意:`workingDir` 仅用于 dashboard 展示/解析,**不会**被 executor 当作
   * spawn cwd —— 后者必须走本机 `resolveIssueCwd` 派生(见 worker.ts
   * "跨机器部署安全"注释),否则多机部署下会把 master 本地路径推给别的机器。
   */
  enrichGroupConversation<T extends { type?: string; groupId?: string } | undefined>(
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

    // Active task issues for the group — used by agents to decide whether
    // file writes are permitted. Cap at 8 to keep prompt small.
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

    // 记忆计数(极简指针注入用,只算 agent_visible=1 且 active 且非 pending)
    const memoryCounts = {
      group: this.db.countMemory("group", conversation.groupId),
      global: this.db.countMemory("global"),
    };

    // skill 计数(该 agent 在该群绑定的 active skill 数,per-agent)
    const skillCount = targetAgentName
      ? this.db.countSkillsForAgent(conversation.groupId, targetAgentName)
      : 0;

    return { ...conversation, activeIssues, workingDir, memoryCounts, skillCount, guidancePrompt: group?.guidance_prompt || undefined } as T;
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
      this.db.createAskBridge({
        id: bridgeId,
        groupId,
        asker: sender,
        target: targetName,
        questionMsgId: msgId,
        escalateTo: null,
        timeoutMs: 5 * 60_000,
      });
      const task = this.db.createScheduledTask({
        name: `${TIMER_PERSONA_NAME} · 等待 ${targetName} 回复`,
        groupId,
        mode: "message",
        scheduleKind: "interval",
        intervalSec: 20,
        prompt: `${TIMER_PERSONA_NAME} 每 20s 检查一次 ${targetName} 有没有回复 ${sender} 的问题;有回复就复述给 ${sender},5 分钟没回复就升级 Issue。`,
        handlerKey: "ask-bridge-check",
        handlerPayload: JSON.stringify({ bridgeId, asker: sender, target: targetName }),
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
      const task = this.db.findAskBridgeScheduledTask(bridge.id);
      if (task && task.enabled) {
        this.db.disableScheduledTask(task.id);
      }
      this.logger.info(`[mesh] bridge ${bridge.id} auto-answered: ${sender} @ ${bridge.asker} (msg ${msgId}), timer task #${task?.id ?? "?"} cancelled`);
    }
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
      const enrichedConversation = this.enrichGroupConversation(conversation);
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
