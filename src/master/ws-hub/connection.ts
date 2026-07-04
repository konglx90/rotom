import { nowBeijing } from "../../shared/time.js";
import { extractMentions } from "../../shared/mention.js";
/**
 * Connection handling — WebSocket lifecycle and message dispatch.
 *
 * Two big methods:
 *   - handleConnection: per-connection message loop. Owns closure state
 *     (authenticated flag, agentId, generation) and dispatches by msg.type
 *     to auth / heartbeat / a2a_send / a2a_reply / a2a_reply_chunk /
 *     a2a_reply_end / update_info / disconnect / issue_update /
 *     issue_approval_request / session_view_response / session_delete_response
 *     / session_snapshot handlers. The handlers stay inside this single
 *     function to keep the closure simple — splitting per-type is a follow-up.
 *   - handleDisconnect: generation-aware, prevents stale close events from
 *     kicking a fresh reconnect.
 *
 * Methods attach via `Object.assign(this, connectionMethods)` in the WSHub
 * composition root. `this` is typed as `WSHubSelf` so cross-module calls
 * (broadcast, enrichGroupConversation,
 * logMessage, etc.) compile.
 */

import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import {
  AUTH_TIMEOUT_MS,
  WS_CLOSE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  PROTOCOL_VERSION,
} from "../../shared/constants.js";
import { isClientMessage, type ClientMessage, type ServerMessage } from "../../shared/protocol.js";
import { isLoopback } from "../../shared/network.js";
import { parseProfile, type WSHubSelf } from "./hub.js";
import { enrichWorkerDispatch } from "./dispatch-enrich.js";
import { resolveGroupRepoCtxLocalOnly } from "../group-paths.js";
import { collectLinksFromText } from "../services/link-collector.js";

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

export const connectionMethods = {
  handleConnection(this: WSHubSelf, ws: WebSocket, req: IncomingMessage): void {
    let authenticated = false;
    let agentId = "";
    let connGeneration = 0;
    const remoteAddr = req.socket.remoteAddress;

    // Must auth within timeout
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(WS_CLOSE.AUTH_TIMEOUT, "Auth timeout");
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (raw) => {
      // Parse
      let msg: ClientMessage;
      try {
        const parsed = JSON.parse(raw.toString());
        if (!isClientMessage(parsed)) {
          ws.close(WS_CLOSE.INVALID_JSON, "Invalid message format");
          return;
        }
        msg = parsed;
      } catch {
        ws.close(WS_CLOSE.INVALID_JSON, "Invalid JSON");
        return;
      }

      // Must authenticate first
      if (!authenticated && msg.type !== "auth") {
        ws.close(WS_CLOSE.NOT_AUTHENTICATED, "Authenticate first");
        return;
      }

      // ── Auth ────────────────────────────────────────────────────────────
      if (msg.type === "auth") {
        clearTimeout(authTimeout);

        // Reject if already authenticated
        if (authenticated) {
          ws.close(WS_CLOSE.AUTH_FAILED, "Already authenticated");
          return;
        }

        // Try JWT reconnect first, then fall back to token auth
        let result: { jwt: string; agent: Record<string, unknown> } | null = null;

        if (msg.jwt) {
          const payload = this.auth.verify(msg.jwt);
          if (payload) {
            const agent = this.db.getAgentById(payload.sub);
            if (agent) {
              // Check if JWT was issued before the last token refresh
              const refreshedAt = this.db.getTokenRefreshedAt(payload.sub);
              const jwtIat = (payload as unknown as Record<string, unknown>).iat as number | undefined;
              if (refreshedAt && jwtIat) {
                const refreshTs = Math.floor(new Date(refreshedAt).getTime() / 1000);
                if (jwtIat < refreshTs) {
                  // JWT was issued before token refresh — reject
                  this.logger.warn(`[mesh] JWT rejected for ${agent.name}: issued before token refresh`);
                  // Fall through to token auth below
                } else {
                  result = this.auth.authenticate(msg.token, msg.name);
                  if (!result) {
                    const freshJwt = this.auth.issueJwt(payload.sub, payload.name, payload.domain);
                    result = { jwt: freshJwt, agent: agent as unknown as Record<string, unknown> };
                  }
                }
              } else {
                // No refresh recorded — allow JWT reconnect
                result = this.auth.authenticate(msg.token, msg.name);
                if (!result) {
                  const freshJwt = this.auth.issueJwt(payload.sub, payload.name, payload.domain);
                  result = { jwt: freshJwt, agent: agent as unknown as Record<string, unknown> };
                }
              }
            }
          }
        }

        if (!result) {
          result = this.auth.authenticate(msg.token, msg.name);
        }

        // Fallback: agent changed name but kept same token
        if (!result && msg.token) {
          result = this.auth.authenticateByToken(msg.token);
          if (result) {
            const oldName = result.agent.name as string;
            if (oldName !== msg.name) {
              // Check name collision — another agent may already have this name
              const nameConflict = this.db.getAgentByName(msg.name);
              if (nameConflict) {
                this.send(ws, { type: "auth_fail", reason: `Name "${msg.name}" is already taken` });
                ws.close(WS_CLOSE.AUTH_FAILED, "Name conflict");
                return;
              }
              this.db.updateAgentName(result.agent.id as string, msg.name);
              result.agent.name = msg.name;
              this.logger.info(`[mesh] Agent renamed: "${oldName}" → "${msg.name}"`);
            }
          }
        }

        // 本机 loopback 兜底认证:来源 IP 是 127.0.0.1 / ::1 时一律信任本机 agent,
        // 无视 token / JWT 是否有效。这是 OPC 模式的核心 —— 本机即真人接入,
        // 不需要 mesh_token 这种"对外认证"机制。每台机器跑 master 后,本机所有
        // executor / CLI 调用都直通。
        if (!result && isLoopback(remoteAddr)) {
          result = this.auth.authenticateLocal(msg.name);
          if (result) {
            this.logger.info(`[mesh] Local trust auth: "${msg.name}" from ${remoteAddr}`);
          }
        }

        if (!result) {
          this.send(ws, { type: "auth_fail", reason: "Invalid token or name" });
          ws.close(WS_CLOSE.AUTH_FAILED, "Auth failed");
          return;
        }

        authenticated = true;
        agentId = result.agent.id as string;
        const agent = result.agent;

        // Kick existing connection if any (same agent reconnecting)
        const existing = this.connections.get(agentId);
        if (existing && existing.ws !== ws) {
          this.logger.info(`[mesh] Kicking old connection for ${agent.name}`);
          existing.ws.close(1000, "Replaced by new connection");
          this.connections.delete(agentId);
          // 旧连接的 issue 订阅必须清掉,否则 usage 推送会发到已死 socket
          // (客户端重连后会重新 subscribe_issue_detail)。
          this.unsubscribeAllIssues(agentId);
        }

        // Assign generation for this connection
        this.generation++;
        connGeneration = this.generation;

        // Update online status
        this.db.setAgentOnline(agentId, msg.instance);

        // Agent-owned: description is accepted from agent auth.
        // profile is NOT accepted here — DB is the authoritative source,
        // updated only via PUT /agents/:id and update_info messages.
        // Otherwise worker restarts would clobber Dashboard-edited position/bio.
        if (msg.description) {
          this.db.updateAgentMeta(agentId, { description: msg.description });
        }
        // Master-owned: domain is IGNORED from agent auth — use DB value

        // Re-read agent from DB to get authoritative domain & enabled
        const freshAgent = this.db.getAgentById(agentId);
        const dbDomain = freshAgent?.domain || (agent.domain as string) || undefined;
        const dbEnabled = freshAgent?.enabled ?? 1;

        // Register connection
        this.connections.set(agentId, {
          ws,
          agentId,
          name: agent.name as string,
          domain: dbDomain,
          cliTool: typeof msg.cliTool === "string" && msg.cliTool ? msg.cliTool : undefined,
          lastHeartbeat: Date.now(),
          generation: connGeneration,
          messageTimestamps: [],
        });

        // Broadcast join
        this.broadcastDirectory("join", {
          name: agent.name as string,
          domain: dbDomain,
          description: freshAgent?.description || msg.description || undefined,
          status: "online",
          enabled: dbEnabled !== 0,
          profile: parseProfile(freshAgent?.profile),
        });

        // Reply auth_ok with directory, protocol version, and master-assigned config
        const directory = this.getDirectory();
        this.send(ws, {
          type: "auth_ok",
          version: PROTOCOL_VERSION,
          jwt: result.jwt,
          directory,
          config: { domain: dbDomain, enabled: dbEnabled !== 0 },
        });

        // Push the worker's active sessions from DB so it can populate its
        // in-memory SessionStore (used for --resume). Replaces the old
        // worker-side ~/.rotom/sessions.json file.
        const cliTool = typeof msg.cliTool === "string" && msg.cliTool ? msg.cliTool : undefined;
        if (cliTool) {
          const rows = this.db.listActiveAgentSessions(agent.name as string, cliTool);
          if (rows.length > 0) {
            this.send(ws, {
              type: "session_sync_push",
              entries: rows.map(r => ({
                cliTool: r.cli_tool,
                groupId: r.group_id,
                sessionId: r.session_id,
                agentName: r.agent_name,
                usage: {
                  inputTokens: r.input_tokens ?? undefined,
                  outputTokens: r.output_tokens ?? undefined,
                  cacheReadTokens: r.cache_read_tokens ?? undefined,
                  cacheCreationTokens: r.cache_creation_tokens ?? undefined,
                  totalCostUsd: r.total_cost_usd ?? undefined,
                },
                model: r.model ?? null,
                cumulativeCostUsd: r.cumulative_cost_usd,
                cumulativeInputTokens: r.cumulative_input_tokens,
                cumulativeOutputTokens: r.cumulative_output_tokens,
                cumulativeCacheReadTokens: r.cumulative_cache_read_tokens,
                cumulativeCacheCreationTokens: r.cumulative_cache_creation_tokens,
              })),
            });
          }
        }

        // Push offline messages
        const offlineMsgs = this.offlineQueue.pop(agentId);
        if (offlineMsgs.length > 0) {
          this.send(ws, { type: "offline_messages", messages: offlineMsgs });
        }

        this.logger.info(`[mesh] ${agent.name} connected (v${msg.version ?? "?"})`);
        return;
      }

      // ── Rate limit check ─────────────────────────────────────────────
      // 流式 chunk（chat reply 的 a2a_reply_chunk / a2a_reply_end、issue
      // 进度的 issue_update）是 session 内的中间产物，只会透传给原始 target，
      // 不会扇出给其他 agent，不该按 a2a_send 那种"防 spam"逻辑限流。新版
      // hermes 把思考流式拆得很细，一次回答可能产生上百个 chunk，套用 60/min
      // 直接被掐断，前端表现就是"思考完就卡住"。
      const conn = this.connections.get(agentId);
      const rateLimitExempt =
        msg.type === "heartbeat" ||
        msg.type === "a2a_reply_chunk" ||
        msg.type === "a2a_reply_end" ||
        msg.type === "issue_update";
      if (conn && !rateLimitExempt) {
        const now = Date.now();
        conn.messageTimestamps = conn.messageTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (conn.messageTimestamps.length >= RATE_LIMIT_MAX) {
          this.send(ws, {
            type: "route_result",
            requestId: (msg as unknown as { requestId?: string }).requestId || "",
            delivered: false,
            queued: false,
            error: "Rate limit exceeded",
          });
          this.logger.warn(`[mesh] Rate limited ${conn.name}`);
          return;
        }
        conn.messageTimestamps.push(now);
      }

      // ── Heartbeat ───────────────────────────────────────────────────────
      if (msg.type === "heartbeat") {
        const conn = this.connections.get(agentId);
        if (conn) conn.lastHeartbeat = Date.now();
        this.db.updateHeartbeat(agentId);
        this.send(ws, { type: "heartbeat_ack" });
        return;
      }

      // ── Send message ────────────────────────────────────────────────────
      if (msg.type === "a2a_send") {
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
          // chat 路径也走 worktree:group 配了 repo 且 target agent 同机时,注入 repoCtx。
          // worker 收到后在 resolveChatCwd 里走 group 模式共享 worktree,可查 repo 代码。
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
            ...(repo ? { repoUrl: repo.repoUrl, repoBranch: repo.repoBranch, extraRepos: repo.extraRepos, worktreeMode: repo.worktreeMode } : {}),
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
        return;
      }

      // ── Reply ───────────────────────────────────────────────────────────
      if (msg.type === "a2a_reply") {
        this.logger.info(`[mesh] Received a2a_reply (non-streaming) for requestId=${msg.requestId}`);
        const { targetId, conversation, conn, fromName, isA2aDirect } = resolveReplyContext(this, msg.requestId, agentId);
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
        return;
      }

      // ── Streaming reply chunk ──────────────────────────────────────────
      if (msg.type === "a2a_reply_chunk") {
        const { targetId, conversation, conn, fromName, isA2aDirect } = resolveReplyContext(this, msg.requestId, agentId);
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
        return;
      }

      // ── Streaming reply end ────────────────────────────────────────────
      if (msg.type === "a2a_reply_end") {
        const { targetId, conversation, conn, fromName, isA2aDirect } = resolveReplyContext(this, msg.requestId, agentId);
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
        return;
      }

      // ── Update info (description / profile push from agent) ───────────
      if (msg.type === "update_info") {
        if (msg.description) {
          this.db.updateAgentMeta(agentId, { description: msg.description });
        }
        if (msg.profile) {
          this.db.updateAgentMeta(agentId, { profile: JSON.stringify(msg.profile) });
        }
        // Re-broadcast directory so dashboards see the update
        this.broadcastAgentUpdate(agentId);
        return;
      }

      // ── Disconnect (graceful) ──────────────────────────────────────────
      if (msg.type === "disconnect") {
        this.handleDisconnect(agentId, connGeneration, "graceful");
        return;
      }

      // ── Issue update (from executor worker) ──────────────────────────
      if (msg.type === "issue_update") {
        const conn = this.connections.get(agentId);
        if (!conn) return;
        const { issueId, status, content, metadata } = msg;
        const issue = this.db.getIssueById(issueId);
        if (!issue) return;

        if (status === "in_progress" || status === "completed" || status === "failed" || status === "paused") {
          const extra: {
            result?: string;
            errorMessage?: string;
            artifacts?: string[];
            sessionId?: string | null;
            cliTool?: string | null;
            usage?: string | null;
            model?: string | null;
          } = {};
          if (status === "completed" && content) extra.result = content;
          if (status === "failed" && content) extra.errorMessage = content;
          if (metadata?.artifacts) extra.artifacts = metadata.artifacts;
          // 续聊用:首次/再次执行结束时 worker 把 cli sessionId 带回来,落到
          // issue 表上,POST /issues/:id/continue 时再读回去 --resume。
          // null = resume failed, clear stale session_id in DB.
          if (metadata?.sessionId !== undefined) {
            extra.sessionId = metadata.sessionId as string | null;
          }
          if (typeof metadata?.cliTool === "string" && metadata.cliTool) {
            extra.cliTool = metadata.cliTool;
          }
          // Token usage / model (claude result / codex turn/completed /
          // hermes usage_update)。usage 序列化为 JSON 字符串入库,前端按需解析。
          if (metadata?.usage !== undefined) {
            extra.usage = typeof metadata.usage === "string"
              ? metadata.usage
              : JSON.stringify(metadata.usage);
          }
          if (typeof metadata?.model === "string" && metadata.model) {
            extra.model = metadata.model;
          }
          // Don't downgrade a cancelled issue back to anything else — but if it
          // arrived after cancellation, still record the event below.
          if (issue.status !== "cancelled") {
            this.db.updateIssueStatus(issueId, status, Object.keys(extra).length > 0 ? extra : undefined);
          }
        }

        // 提取 composedPrompt 并嵌入 issue_event 的 metadata,前端可像消息气泡一样
        // 点击 🔍 prompt 看分层。
        const cp = (msg as any).composedPrompt as
          | { layers: { layer: string; content: string; source: string }[]; final: string; generatedAt: string; promptVersion: string }
          | undefined;
        const eventMeta: Record<string, unknown> = metadata ? { ...metadata } : {};
        if (msg.cwd) eventMeta.cwd = msg.cwd;
        if (cp && cp.layers && cp.final) {
          eventMeta.composed_prompt = cp;
        }
        this.db.addIssueEvent({
          issueId,
          eventType: status === "in_progress" ? "progress" :
                     status === "completed" ? "completed" :
                     status === "failed" ? "failed" :
                     status === "paused" ? "paused" : "output",
          agentName: conn.name,
          content: content || "",
          metadata: Object.keys(eventMeta).length > 0 ? eventMeta : undefined,
        });

        // Notify group when issue is completed or failed
        if ((status === "completed" || status === "failed") && issue.group_id) {
          const artifacts = metadata?.artifacts;
          const summary = status === "completed"
            ? `✅ Issue 「${issue.title}」已由 ${conn.name} 完成`
            : `❌ Issue 「${issue.title}」执行失败（${conn.name}）`;
          const details = artifacts?.length
            ? `${summary}\n\n产出文件：${(artifacts as string[]).join("、")}`
            : summary;
          // Master-proactive announcement → sender=system.
          this.postSystemToGroup(issue.group_id, details);
        }

        this.send(ws, { type: "issue_update_ack" as const, issueId, ok: true });
        this.notifyIssueChanged(issueId, issue.group_id, "event_appended");
        this.logger.info(`[mesh] Issue ${issueId} update: ${status} from ${conn.name}`);
        return;
      }

      // ── Issue todos update (claude-code worker pushes TodoWrite snapshots)
      //
      // 与 issue_update 平行的 side-channel:只更新 issues.latest_todos_json
      // 快照 + 可选追加一条 event_type='todos' 时间线事件,**不动 issue 状态**。
      // todos 内容 hash 去重:相邻两次相同则不重复落 event(避免时间线被同一条
      // todos 反复刷屏);快照列始终覆盖更新,保证 dashboard 取到的总是最新。
      if (msg.type === "issue_todos_update") {
        const conn = this.connections.get(agentId);
        if (!conn) return;
        const issue = this.db.getIssueById(msg.issueId);
        if (!issue) {
          this.logger.warn(`[mesh] issue_todos_update for unknown issue ${msg.issueId}`);
          return;
        }
        const todos = Array.isArray(msg.todos) ? msg.todos : [];
        const serialized = JSON.stringify(todos);
        const previousSnapshot = issue.latest_todos_json ?? "";
        const changed = previousSnapshot !== serialized;
        this.db.updateIssueTodos(msg.issueId, todos);
        if (changed) {
          this.db.addIssueEvent({
            issueId: msg.issueId,
            eventType: "todos",
            agentName: conn.name,
            content: "",
            metadata: { todos, count: todos.length },
          });
        }
        this.notifyIssueChanged(msg.issueId, issue.group_id, "event_appended");
        this.logger.info(
          `[mesh] Issue ${msg.issueId} todos update from ${conn.name}: ${todos.length} item(s)${changed ? "" : " (no-change skip event)"}`,
        );
        return;
      }

      // 执行过程中 worker 上报累积 token usage(每秒最多 1 次节流后)。
      // **不落 DB**——只在内存转发给订阅了该 issue 详情的 dashboard 客户端,
      // reload 后客户端从 issue.usage(终态 result.usage 落库)拿值。区别于
      // issue_todos_update:todos 要写 DB(覆盖快照 + 时间线),usage 纯流式。
      if (msg.type === "issue_usage_progress") {
        this.sendToIssueSubscribers(msg.issueId, {
          type: "issue_usage_progress",
          issueId: msg.issueId,
          usage: msg.usage,
        });
        return;
      }

      // dashboard 客户端订阅 / 取消订阅某 issue 的实时推送。issue_usage_progress
      // 只推给订阅者,避免给所有群成员打高频流量。重连时客户端必须重发订阅
      // (订阅不跨连接保留,disconnect 时由 unsubscribeAllIssues 清掉)。
      if (msg.type === "subscribe_issue_detail") {
        this.subscribeIssue(msg.issueId, agentId);
        return;
      }
      if (msg.type === "unsubscribe_issue_detail") {
        this.unsubscribeIssue(msg.issueId, agentId);
        return;
      }

      // ── Issue approval request (codex etc. asks for human Accept/Deny) ─
      if (msg.type === "issue_approval_request") {
        const conn = this.connections.get(agentId);
        if (!conn) return;
        const issue = this.db.getIssueById(msg.issueId);
        if (!issue) {
          this.logger.warn(`[mesh] approval_request for unknown issue ${msg.issueId}`);
          return;
        }
        this.db.addIssueEvent({
          issueId: msg.issueId,
          eventType: "approval_request",
          agentName: conn.name,
          content: msg.summary,
          metadata: {
            approvalId: msg.approvalId,
            kind: msg.kind,
            command: msg.command,
            cwd: msg.cwd,
            files: msg.files,
            plan: msg.plan,
            diff: msg.diff,
            questions: msg.questions,
            status: "pending",
            requestedBy: conn.name,
          },
        });
        this.notifyIssueChanged(msg.issueId, issue.group_id, "event_appended");
        this.logger.info(`[mesh] Approval requested by ${conn.name} on issue ${msg.issueId} (${msg.kind}, id=${msg.approvalId})`);
        return;
      }

      // ── Session management responses from worker (Master → Executor) ──
      if (msg.type === "session_view_response" || msg.type === "session_delete_response") {
        const pending = this.pendingSessionRequests.get(msg.requestId);
        if (pending) {
          this.pendingSessionRequests.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
        return;
      }

      // ── Session snapshot push (worker → master DB) ───────────────────
      if (msg.type === "session_snapshot") {
        // worker 推它当前所有 active sessions;master upsert 到 DB 持久化。
        // in-memory cache 同步更新(供 /sessions 快速查询 + online 判定)。
        const conn = this.connections.get(agentId);
        const agentName = conn?.name;
        if (agentName) {
          for (const entry of msg.entries) {
            this.db.upsertAgentSession({
              groupId: entry.groupId,
              agentName,
              cliTool: entry.cliTool,
              sessionId: entry.sessionId,
              usage: entry.usage ?? undefined,
              model: entry.model ?? undefined,
              cumulativeCostUsd: entry.cumulativeCostUsd,
              cumulativeInputTokens: entry.cumulativeInputTokens,
              cumulativeOutputTokens: entry.cumulativeOutputTokens,
              cumulativeCacheReadTokens: entry.cumulativeCacheReadTokens,
              cumulativeCacheCreationTokens: entry.cumulativeCacheCreationTokens,
            });
          }
        }
        this.sessionSnapshots.set(agentId, msg.entries);
        return;
      }

      // ── Session invalidated (worker → master: 标记失效,保留历史) ────
      if (msg.type === "session_invalidated") {
        this.db.invalidateAgentSession(msg.cliTool, msg.groupId, msg.sessionId);
        this.logger.info(
          `[mesh] Session invalidated: ${msg.cliTool}:${msg.groupId} → ${msg.sessionId}`,
        );
        return;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (authenticated) {
        this.handleDisconnect(agentId, connGeneration, "ws_closed");
      }
    });

    ws.on("error", (err: Error) => {
      this.logger.warn(`[mesh] WS error:`, err.stack || err.message);
    });
  },

  handleDisconnect(this: WSHubSelf, agentId: string, generation: number, reason: string): void {
    const conn = this.connections.get(agentId);
    if (!conn) return;

    // Only disconnect if this is the SAME generation (not a newer reconnection)
    if (conn.generation !== generation) return;

    this.connections.delete(agentId);
    this.db.setAgentOffline(agentId);
    // Drop the worker's session snapshot so the dashboard doesn't surface
    // stale sessions for an offline executor. The worker re-pushes a fresh
    // snapshot on next auth.
    this.sessionSnapshots.delete(agentId);
    // Clean up issue detail subscriptions so usage pushes don't go to a dead
    // socket. Re-subscribe happens on the next connect (client ws.onopen).
    this.unsubscribeAllIssues(agentId);

    this.broadcastDirectory("leave", {
      name: conn.name,
      domain: conn.domain,
      status: "offline",
    });

    // Close WebSocket if still open
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(1000, reason);
    }

    this.logger.info(`[mesh] ${conn.name} disconnected (${reason})`);
  },
} as const;
