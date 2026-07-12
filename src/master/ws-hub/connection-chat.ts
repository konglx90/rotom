/**
 * Connection — a2a chat / reply 消息处理器(从 connection.ts 拆出)。
 *
 * handleConnection 的消息分发里,a2a_send / a2a_reply / a2a_reply_chunk /
 * a2a_reply_end 四个分支自成一组(聊天 / 回复路由),是 connection.ts 里最大
 * 的一块(~400 行)。抽成独立方法包,挂在 WSHub 上(handleConnection 里改为一行
 * dispatch),把 connection.ts 从 1031 行降到 ~640。
 *
 * 各 handler 的 this 是 WSHubSelf(同 routing.ts / conversation.ts 等域模块),
 * 跨模块调用(sendToAgent / broadcastToGroup / enrichGroupConversation 等)
 * 直接走 this。每个 handler 收 (agentId, msg)(a2a_send 额外要 ws 用于回 route_result)
 * —— 这些原本是 handleConnection 闭包里的变量,现在显式传入。
 */

import { WebSocket } from "ws";
import { nowBeijing } from "../../shared/time.js";
import { extractMentions } from "../../shared/mention.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { WSHubSelf } from "./hub.js";
import { enrichWorkerDispatch } from "./dispatch-enrich.js";
import { resolveGroupRepoCtxLocalOnly } from "../group-paths.js";
import { collectLinksFromText } from "../services/link-collector.js";

type A2aSendMsg = Extract<ClientMessage, { type: "a2a_send" }>;
type A2aReplyMsg = Extract<ClientMessage, { type: "a2a_reply" }>;
type A2aReplyChunkMsg = Extract<ClientMessage, { type: "a2a_reply_chunk" }>;
type A2aReplyEndMsg = Extract<ClientMessage, { type: "a2a_reply_end" }>;

interface ReplyContext {
  targetId: string | undefined;
  conversation: ReturnType<WSHubSelf["router"]["getConversation"]>;
  conn: ReturnType<WSHubSelf["connections"]["get"]>;
  fromName: string;
  isA2aDirect: boolean;
}

/**
 * Shared preamble for a2a_reply / a2a_reply_chunk / a2a_reply_end handlers.
 * Resolves the routing target + connection metadata + group-type flag that
 * all three reply branches need before deciding whether to broadcast,
 * unicast, or skip dispatch.
 *
 * Pulled out so the three branches don't repeat the same 5-line lookup.
 * The branches still own their (different) persistence + dispatch shapes
 * because chunk/end/reply have meaningfully different semantics.
 */
function resolveReplyContext(hub: WSHubSelf, requestId: string, agentId: string): ReplyContext {
  const targetId = hub.router.resolveReplyTarget(requestId);
  const conversation = hub.router.getConversation(requestId);
  const conn = hub.connections.get(agentId);
  const fromName = conn?.name || "unknown";
  const isA2aDirect = conversation?.groupId
    ? hub.db.getGroupById(conversation.groupId)?.type === "a2a_direct"
    : false;
  return { targetId, conversation, conn, fromName, isA2aDirect };
}

export const connectionChatMethods = {
  handleA2aSend(this: WSHubSelf, ws: WebSocket, agentId: string, msg: A2aSendMsg): void {
    const sendTs = Date.now();
    const result = this.router.route(agentId, msg);
    const conn = this.connections.get(agentId);
    const fromName = conn?.name || "unknown";
    const fromDomain = conn?.domain;
    const routeType = "exact";

    // Block messages for archived groups
    if (msg.conversation?.groupId && this.db.isGroupArchived(msg.conversation.groupId)) {
      this.send(ws, {
        type: "route_result",
        requestId: msg.requestId,
        delivered: false,
        queued: false,
        error: "Group is archived",
      });
      return;
    }

    let delivered = false;
    let queued = false;

    if (result.targetAgentId) {
      const enrichedConversation = this.enrichGroupConversation(msg.conversation, result.targetName);
      // chat 不走 worktree:cwd 落产物根(repo 作 __repos/<repoName>/ 子目录只读访问)。
      // 仅下发 repoUrl 供 worker 算 prompt 提示名,不再下发 branch/extra/mode(那些
      // 是 worktree 用的)。issue 路径的 repoCtx 注入在 routing.ts,互不影响。
      const groupIdForRepo = enrichedConversation?.groupId;
      const repo = groupIdForRepo && result.targetName
        ? resolveGroupRepoCtxLocalOnly(this.db, groupIdForRepo, result.targetName)
        : null;
      const outMsg = enrichWorkerDispatch(this, {
        type: "a2a_message" as const,
        requestId: msg.requestId,
        from: { name: fromName, domain: fromDomain, status: "online" as const },
        payload: msg.payload,
        routeType,
        conversation: enrichedConversation,
        ...(repo?.repoUrl ? { repoUrl: repo.repoUrl } : {}),
      } as ServerMessage, result.targetName, enrichedConversation?.groupId);
      delivered = this.sendToAgent(result.targetAgentId, outMsg);

      // Persist + (for group) broadcast. Group messages are also delivered to
      // the rest of the group via broadcastToGroup so dashboards/agents can see
      // the conversation in real-time (mirrors a2a_reply behavior at L462-465).
      // excludeAgentIds covers both the sender and the targeted agent so the
      // target does not receive the same a2a_message twice.
      if ((msg.conversation?.type === "group" || msg.conversation?.type === "single") && msg.conversation.groupId) {
        // 兜底:发信人不在 group_members 时自动 addMembers(防"自激丢消息" +
        // "多 tab 真人看不到自己的消息")。INSERT OR IGNORE 幂等。
        const groupMembers = this.db.getGroupMembers(msg.conversation.groupId);
        if (!groupMembers.some((m) => m.agent_name === fromName)) {
          this.db.addGroupMembers(msg.conversation.groupId, [fromName]);
          this.logger.info(`[mesh] a2a_send group: auto-joined sender "${fromName}" as group member`);
        }

        const mentions = extractMentions(msg.payload?.message);
        // Skip db.addGroupMessage for group messages: the Dashboard /
        // CLI REST endpoint already persists via POST /groups/:id/messages.
        // Without this skip, sending one a2a_send per @mentioned agent
        // (N sends) would store the same message N times.
        if (msg.conversation.type !== "group") {
          this.db.addGroupMessage(msg.conversation.groupId, fromName, msg.payload?.message || "", mentions);
          this.db.bumpGroupActivity(msg.conversation.groupId);
        }

        if (msg.conversation.type === "group") {
          // Exclude ALL @mentioned agents from broadcast — not just the
          // current result.targetAgentId. When the Dashboard sends one
          // a2a_send per @mentioned target (e.g. @A @B @C -> 3 sends),
          // each send's broadcast only excludes its own target, causing
          // other mentioned agents to receive duplicate copies via
          // broadcast on top of their own direct delivery.
          //
          // 单播群(unicast, type=a2a_direct):跳过广播。消息只进 group history,
          // 无 WS push,非 target 成员的 worker 不会被 @ 自动触发。
          // CLI --need-reply 显式点名才叫醒 target worker 回复。
          const a2aDirect = this.db.getGroupById(msg.conversation.groupId)?.type === "a2a_direct";
          if (!a2aDirect) {
            const mentionAgentIds = mentions
              .map((name: string) => this.db.getAgentByName(name)?.id)
              .filter((id: string | undefined): id is string => !!id);
            this.broadcastToGroup(
              msg.conversation.groupId,
              outMsg,
              [agentId, result.targetAgentId, ...mentionAgentIds],
            );
          }
        }
      }

      if (!delivered) {
        queued = this.offlineQueue.enqueue(
          result.targetAgentId, fromName, fromDomain,
          msg.payload, routeType,
        );
      }
    }

    // Log message
    this.db.logMessage({
      requestId: msg.requestId,
      fromName,
      fromDomain,
      toName: result.targetName,
      toDomain: result.targetAgentId ? this.db.getAgentById(result.targetAgentId)?.domain ?? undefined : undefined,
      routeType,
      direction: "send",
      payload: JSON.stringify(msg.payload),
      status: result.error ? "failed" : queued ? "queued" : delivered ? "routed" : "no_target",
      groupId: msg.conversation?.groupId,
      source: "ws",
    });

    // Store send timestamp for latency calc on reply
    if (result.targetAgentId) {
      this.sendTimestamps.set(msg.requestId, sendTs);
    }

    this.send(ws, {
      type: "route_result",
      requestId: msg.requestId,
      delivered, queued,
      error: result.error,
    });
  },

  handleA2aReply(this: WSHubSelf, agentId: string, msg: A2aReplyMsg): void {
    this.logger.info(`[mesh] Received a2a_reply (non-streaming) for requestId=${msg.requestId}`);
    const { targetId, conversation, conn, fromName, isA2aDirect } = resolveReplyContext(this, msg.requestId, agentId);

    // ── Federation reply branch ─────────────────────────────────────
    // 本地 agent 给一个 federated 请求(来自远端 member / link daemon,经
    // FedDeliver 投到本机)回了消息 → 不走本地 sendToAgent,改通过
    // router.fedReplyHook 把 FedReply 发回协调 master,协调再广播给所有 member,
    // 由发起端的 FedClient.handleReply 解开 pendingRequest。
    if (this.router.isFederatedRequest(msg.requestId)) {
      const replyContent = msg.payload?.message || "";
      this.logger.info(`[mesh] Federated reply for requestId=${msg.requestId} from ${fromName} (${replyContent.length} chars)`);
      this.db.logMessage({
        requestId: msg.requestId,
        fromName,
        fromDomain: conn?.domain,
        toName: undefined,
        toDomain: undefined,
        routeType: "reply",
        direction: "reply",
        payload: JSON.stringify(msg.payload),
        status: "replied",
        latencyMs: this.sendTimestamps.get(msg.requestId) ? Date.now() - this.sendTimestamps.get(msg.requestId)! : undefined,
        groupId: conversation?.groupId,
        source: "ws",
      });
      try {
        this.router.fedReplyHook?.(msg.requestId, fromName, { message: replyContent });
      } catch (err) {
        this.logger.warn(`[mesh] fedReplyHook error for requestId=${msg.requestId}: ${(err as Error).message}`);
      }
      return;
    }

    if (targetId) {
      const targetAgent = this.db.getAgentById(targetId);
      const enrichedConversation = this.enrichGroupConversation(conversation, targetAgent?.name);
      // qaMode:硬剥 @<asker> 防止 asker worker 被回触发(一问一答,不 chatter)
      const qaAsker = this.qaModeAskers.get(msg.requestId);
      let replyContent = msg.payload?.message || "";
      if (qaAsker) {
        replyContent = replyContent.replace(new RegExp(`@${qaAsker}\\b`, "g"), "");
        this.qaModeAskers.delete(msg.requestId);
      }
      const replyPayload = { ...msg.payload, message: replyContent };
      const replyMsg = enrichWorkerDispatch(this, {
        type: "a2a_message" as const,
        requestId: msg.requestId,
        from: { name: fromName, domain: conn?.domain, status: "online" as const },
        payload: replyPayload,
        routeType: "reply" as const,
        conversation: enrichedConversation,
      } as ServerMessage, targetAgent?.name, enrichedConversation?.groupId) as unknown as Record<string, unknown>;
      if (msg.cwd) replyMsg.cwd = msg.cwd;

      // Persist to group history BEFORE sending (avoids race with history refresh)
      if ((conversation?.type === "group" || conversation?.type === "single") && conversation.groupId) {
        const msgId = this.db.addGroupMessage(conversation.groupId, fromName, replyContent, []);
        this.db.bumpGroupActivity(conversation.groupId);
        // 提取 mentions 走 bridge 检测(同 sendAsAgent 的 regex)
        const mentions = extractMentions(replyContent);
        this.autoCreateBridgeOnMention(conversation.groupId, fromName, mentions, msgId);
        this.checkAndCancelBridgesForMessage(conversation.groupId, fromName, mentions, msgId);
        // 链接采集(inline hook,失败不影响主路径)
        collectLinksFromText(replyContent, {
          sourceType: "group_message",
          sourceId: String(msgId),
          sourceGroupId: conversation.groupId,
          sourceSender: fromName,
        }, this.db);
      }

      // Group replies: broadcast to all members so everyone sees it in real-time
      // DM replies: send to original sender only
      // 单播群(unicast):跳过 broadcast(消息已入库,asker 通过 history 拉)。
      //   不调 sendToAgent(target=asker)因为 asker 是 CLI 无 WS 连接,
      //   推也推不到 —— 这正是 unicast 的设计:一对一点对点,免打扰。
      if (conversation?.type === "group" && conversation.groupId && !isA2aDirect) {
        this.broadcastToGroup(conversation.groupId, replyMsg as unknown as Parameters<typeof this.sendToAgent>[1], [agentId]);
      } else if (conversation?.type !== "group") {
        // DM only — unicast 路径到这里直接落入"什么都不发"分支
        this.sendToAgent(targetId, replyMsg as unknown as Parameters<typeof this.sendToAgent>[1]);
      }

      // Log reply with latency. toName 优先用 @ 到的 agent(群回复 @ 了谁就是写给谁),
      // 没提到 agent 才回落到 reply target(原始发送方)。
      const sendTs = this.sendTimestamps.get(msg.requestId);
      const latencyMs = sendTs ? Date.now() - sendTs : undefined;
      const replyMentions = extractMentions(msg.payload?.message);
      const firstMentionedName = replyMentions.find((n: string) => this.db.getAgentByName(n));
      const logToAgent = firstMentionedName ? this.db.getAgentByName(firstMentionedName) : targetAgent;
      this.db.logMessage({
        requestId: msg.requestId,
        fromName,
        fromDomain: conn?.domain,
        toName: logToAgent?.name,
        toDomain: logToAgent?.domain ?? undefined,
        routeType: "reply",
        direction: "reply",
        payload: JSON.stringify(msg.payload),
        status: "replied",
        latencyMs,
        groupId: conversation?.groupId,
        source: "ws",
      });
    } else {
      this.logger.warn(`[mesh] Reply target not found for requestId=${msg.requestId}`);
    }
  },

  handleA2aReplyChunk(this: WSHubSelf, agentId: string, msg: A2aReplyChunkMsg): void {
    const { targetId, conversation, conn, fromName, isA2aDirect } = resolveReplyContext(this, msg.requestId, agentId);
    // Federation:chunk 不转发给 link/远端 member(跨 master 流式太重);
    //              最终完整内容随 a2a_reply_end 一次性以 FedReply 发回。
    if (this.router.isFederatedRequest(msg.requestId)) {
      return;
    }
    if (targetId) {
      const chunkMsg = {
        type: "a2a_stream_chunk" as const,
        requestId: msg.requestId,
        from: { name: fromName, domain: conn?.domain, status: "online" as const },
        delta: msg.delta,
        conversation,
      };
      // Send stream chunk to original sender only (streaming is per-session, no broadcast)
      // 单播群(unicast):跳过广播,asker 通过 history 拉最终内容(中途流式 UI 不可见,
      //   但功能层面不受影响 —— 完整 reply 在 a2a_reply_end 入库)。
      if (conversation?.type === "group" && conversation.groupId && !isA2aDirect) {
        this.broadcastToGroup(conversation.groupId, chunkMsg, [agentId]);
      } else if (conversation?.type !== "group") {
        this.sendToAgent(targetId, chunkMsg);
      }
    }
  },

  handleA2aReplyEnd(this: WSHubSelf, agentId: string, msg: A2aReplyEndMsg): void {
    const { targetId, conversation, conn, fromName, isA2aDirect } = resolveReplyContext(this, msg.requestId, agentId);
    // Federation:本地 agent 给一个 federated 请求回完了流式回复 →
    // 把最终完整 payload 通过 fedReplyHook 一次性以 FedReply 发回协调 master。
    // (chunk 阶段已经被 isFederatedRequest 分支丢弃,所以最终内容只在 end 这里。)
    if (this.router.isFederatedRequest(msg.requestId)) {
      const endContent = msg.payload?.message || "";
      this.logger.info(`[mesh] Federated reply-end for requestId=${msg.requestId} from ${fromName} (${endContent.length} chars)`);
      this.db.logMessage({
        requestId: msg.requestId,
        fromName,
        fromDomain: conn?.domain,
        toName: undefined,
        toDomain: undefined,
        routeType: "reply",
        direction: "reply",
        payload: JSON.stringify(msg.payload),
        status: "replied",
        latencyMs: this.sendTimestamps.get(msg.requestId) ? Date.now() - this.sendTimestamps.get(msg.requestId)! : undefined,
        groupId: conversation?.groupId,
        source: "ws",
      });
      try {
        this.router.fedReplyHook?.(msg.requestId, fromName, { message: endContent });
      } catch (err) {
        this.logger.warn(`[mesh] fedReplyHook error for requestId=${msg.requestId}: ${(err as Error).message}`);
      }
      return;
    }
    if (targetId) {
      const cancelled = msg.cancelled === true;
      const endMsg: Record<string, unknown> = {
        type: "a2a_stream_end" as const,
        requestId: msg.requestId,
        from: { name: fromName, domain: conn?.domain, status: "online" as const },
        conversation,
      };
      if (msg.cwd) endMsg.cwd = msg.cwd;
      if (cancelled) endMsg.cancelled = true;
      // qaMode:硬剥 @<asker> 防止 asker worker 被回触发(一问一答,不 chatter)
      const qaAsker = this.qaModeAskers.get(msg.requestId);
      let endContent = msg.payload?.message || "";
      if (qaAsker) {
        endContent = endContent.replace(new RegExp(`@${qaAsker}\\b`, "g"), "");
        this.qaModeAskers.delete(msg.requestId);
      }
      const endPayload = { ...msg.payload, message: endContent };
      // Persist to group history BEFORE sending (avoids race with history refresh).
      // Cancelled replies still persist their partial content (the user wants
      // to keep what was streamed before the interrupt) but stamp cancelled_at
      // so the dashboard can render the "⏹ 已中断" footer on reload.
      if ((conversation?.type === "group" || conversation?.type === "single") && conversation.groupId) {
        const msgId = this.db.addGroupMessage(
          conversation.groupId,
          fromName,
          endContent,
          [],
          cancelled ? { cancelledAt: nowBeijing() } : undefined,
        );
        this.db.bumpGroupActivity(conversation.groupId);
        const mentions = extractMentions(endContent);
        this.autoCreateBridgeOnMention(conversation.groupId, fromName, mentions, msgId);
        this.checkAndCancelBridgesForMessage(conversation.groupId, fromName, mentions, msgId);
        // 链接采集(inline hook,失败不影响主路径)
        collectLinksFromText(endContent, {
          sourceType: "group_message",
          sourceId: String(msgId),
          sourceGroupId: conversation.groupId,
          sourceSender: fromName,
        }, this.db);
        // 把 worker 回传的 composedPrompt 持久化,前端点击消息可直接读出来渲染分层。
        // 中断态也保留(用户可能想看 prompt 排查为何中断),只要 worker 带了就存。
        const cp = (msg as any).composedPrompt as
          | { layers: { layer: string; content: string; source: string }[]; final: string; generatedAt: string; promptVersion: string }
          | undefined;
        if (cp && cp.layers && cp.final) {
          try {
            this.db.addChatMessagePrompt(
              msgId,
              JSON.stringify(cp.layers),
              cp.final,
              cp.generatedAt ?? nowBeijing(),
              cp.promptVersion ?? "unknown",
            );
          } catch (err: any) {
            this.logger.warn(`[mesh] Failed to persist composedPrompt for msgId=${msgId}: ${err.message}`);
          }
        }
      }

      // Group stream end: broadcast a2a_message(带完整内容)给群成员,
      // 让其他 agent 的 worker 能处理(worker 只认 a2a_message,不认 a2a_stream_end)。
      // a2a_stream_end 只发给原始 target,用于 Dashboard 流式 UI 收尾。
      // 单播群(unicast):跳过 broadcast,消息已经入库(本 handler 上方 addGroupMessage)。
      if (conversation?.type === "group" && conversation.groupId && !isA2aDirect) {
        const groupMsg = enrichWorkerDispatch(this, {
          type: "a2a_message" as const,
          requestId: msg.requestId,
          from: { name: fromName, domain: conn?.domain, status: "online" as const },
          payload: endPayload,
          routeType: "reply" as const,
          conversation: this.enrichGroupConversation(conversation),
        } as ServerMessage, undefined, conversation.groupId);
        this.broadcastToGroup(conversation.groupId, groupMsg as unknown as Parameters<typeof this.sendToAgent>[1], [agentId]);
      }
      // a2a_stream_end 发给原始 target(发起方 Dashboard 收尾流式 UI)
      this.sendToAgent(targetId, endMsg as unknown as Parameters<typeof this.sendToAgent>[1]);

      // Log complete reply with latency. toName 优先用 @ 到的 agent。
      const sendTs = this.sendTimestamps.get(msg.requestId);
      const latencyMs = sendTs ? Date.now() - sendTs : undefined;
      const targetAgent = this.db.getAgentById(targetId);
      const endMentions = extractMentions(msg.payload?.message);
      const firstMentionedName = endMentions.find((n: string) => this.db.getAgentByName(n));
      const logToAgent = firstMentionedName ? this.db.getAgentByName(firstMentionedName) : targetAgent;
      this.db.logMessage({
        requestId: msg.requestId,
        fromName,
        fromDomain: conn?.domain,
        toName: logToAgent?.name,
        toDomain: logToAgent?.domain ?? undefined,
        routeType: "reply",
        direction: "reply",
        payload: JSON.stringify(msg.payload),
        status: cancelled ? "cancelled" : "replied",
        latencyMs,
        groupId: conversation?.groupId,
        source: "ws",
      });
      this.sendTimestamps.delete(msg.requestId);
    }
  },
};
