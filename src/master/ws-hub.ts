/**
 * Digital Employee Mesh — WebSocket Hub
 *
 * Manages all Agent WebSocket connections. Handles:
 * - Auth (10s timeout) with token or JWT reconnect
 * - Heartbeat checking (90s timeout)
 * - Message routing (via Router decisions)
 * - Reply correlation (via Router.resolveReplyTarget)
 * - Directory broadcast
 * - Offline message delivery on reconnect
 * - Rate limiting per agent
 * - Protocol version check
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { MeshDb } from "./db.js";
import type { AuthService } from "./auth.js";
import type { Router } from "./router.js";
import type { OfflineQueue } from "./offline-queue.js";
import type {
  ClientMessage,
  ServerMessage,
  AgentInfo,
  AgentProfile,
  ClientSessionViewResponse,
  ClientSessionDeleteResponse,
  SessionEntry,
} from "../shared/protocol.js";
import { isClientMessage } from "../shared/protocol.js";
import {
  AUTH_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_CHECK_INTERVAL_MS,
  CLEANUP_INTERVAL_MS,
  PENDING_REQUEST_TTL_MS,
  WS_CLOSE,
  WS_MAX_PAYLOAD,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  PROTOCOL_VERSION,
} from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Connected agent state (in-memory)
// ---------------------------------------------------------------------------

interface ConnectedAgent {
  ws: WebSocket;
  agentId: string;
  name: string;
  domain?: string;
  /**
   * CLI tool name the executor is bound to (claude | codex | hermes | openclaw).
   * Captured at auth time from ClientAuthMessage.cliTool and used by
   * routeToExecutor() to pick the right worker for /sessions endpoints.
   */
  cliTool?: string;
  lastHeartbeat: number;
  /** Monotonic generation counter — used to prevent stale close events from kicking new connections */
  generation: number;
  /** Rate limiting: timestamps of recent messages */
  messageTimestamps: number[];
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// WSHub
// ---------------------------------------------------------------------------

type PendingSession = {
  resolve: (msg: ClientSessionViewResponse | ClientSessionDeleteResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WSHub {
  private wss: WebSocketServer;
  private connections = new Map<string, ConnectedAgent>(); // agentId → conn
  private sendTimestamps = new Map<string, number>(); // requestId → send timestamp (for latency)
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0; // global generation counter
  /**
   * In-flight session management requests awaiting a worker response. Keyed
   * by requestId; each entry holds a resolver + a setTimeout that fires
   * routeToExecutor's rejection with a timeout error. Cleaned up in the
   * session response handler (first response wins, except for broadcasts
   * which collect all responses until timeout).
   */
  private pendingSessionRequests = new Map<string, PendingSession>();

  /**
   * In-memory cache of each worker's SessionStore. Workers push a
   * `session_snapshot` after auth and after every mutation; we replace the
   * entry on receipt. This powers the dashboard's `GET /sessions?groupId=X`
   * without WS round-trips — fast list, no broadcast.
   *
   * Key is `ConnectedAgent.id` (workerAgentId). On disconnect we drop the
   * entry so offline workers don't surface stale sessions; the next reconnect
   * re-pushes a snapshot.
   */
  private sessionSnapshots = new Map<string, SessionEntry[]>();

  constructor(
    httpServer: Server,
    private db: MeshDb,
    private auth: AuthService,
    private router: Router,
    private offlineQueue: OfflineQueue,
    private logger: Logger,
  ) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/ws",
      maxPayload: WS_MAX_PAYLOAD,
    });
  }

  start(): void {
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Periodic heartbeat check
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [agentId, conn] of this.connections) {
        if (conn.ws.readyState !== WebSocket.OPEN || now - conn.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          const reason = conn.ws.readyState !== WebSocket.OPEN ? "ws_closed" : "heartbeat_timeout";
          this.handleDisconnect(agentId, conn.generation, reason);
        }
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);

    // Periodic cleanup of sendTimestamps (prevents memory leak)
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.sendTimestamps) {
        if (now - ts > PENDING_REQUEST_TTL_MS) {
          this.sendTimestamps.delete(id);
        }
      }

      // Also clean up old logs periodically (every cycle)
      try { this.db.cleanupOldLogs(); } catch { /* non-fatal */ }
    }, CLEANUP_INTERVAL_MS);

    this.logger.info("[mesh-master] WebSocket Hub started");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Connection handling
  // ═══════════════════════════════════════════════════════════════════════════

  private handleConnection(ws: WebSocket): void {
    let authenticated = false;
    let agentId = "";
    let connGeneration = 0;

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
        }

        // Assign generation for this connection
        this.generation++;
        connGeneration = this.generation;

        // Update online status
        this.db.setAgentOnline(agentId, msg.instance);

        // Agent-owned fields: accept description and profile from agent
        if (msg.description) {
          this.db.updateAgentMeta(agentId, { description: msg.description });
        }
        if (msg.profile) {
          this.db.updateAgentMeta(agentId, { profile: JSON.stringify(msg.profile) });
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
            requestId: (msg as any).requestId || "",
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
          const enrichedConversation = this.enrichConversationWithCollaboration(msg.conversation, result.targetName);
          const outMsg = {
            type: "a2a_message" as const,
            requestId: msg.requestId,
            from: { name: fromName, domain: fromDomain, status: "online" as const },
            payload: msg.payload,
            routeType,
            conversation: enrichedConversation,
          };
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

            const mentions = msg.payload?.message?.match(/@([\w一-鿿][\w.一-鿿-]*)/g)?.map((m: string) => m.slice(1)) || [];
            this.db.addGroupMessage(msg.conversation.groupId, fromName, msg.payload?.message || "", mentions);

            if (msg.conversation.type === "group") {
              this.broadcastToGroup(
                msg.conversation.groupId,
                outMsg,
                [agentId, result.targetAgentId],
              );

              // 协作轮次:mesh_group_send 走的也是 a2a_send,需要同样计入贡献,
              // 否则 firstParticipant 用工具 @ 别人这一步永远不会被算作"已发言",
              // 导致整轮永远不完成、轮数不推进、自动总结永远不触发。
              this.trackCollaborationTurn(msg.conversation.groupId, fromName, msg.payload?.message || "");
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
        const targetId = this.router.resolveReplyTarget(msg.requestId);
        const conversation = this.router.getConversation(msg.requestId);
        if (targetId) {
          const conn = this.connections.get(agentId);
          const fromName = conn?.name || "unknown";
          const targetAgent = this.db.getAgentById(targetId);
          const enrichedConversation = this.enrichConversationWithCollaboration(conversation, targetAgent?.name);
          const replyMsg: Record<string, unknown> = {
            type: "a2a_message" as const,
            requestId: msg.requestId,
            from: { name: fromName, domain: conn?.domain, status: "online" as const },
            payload: msg.payload,
            routeType: "reply" as const,
            conversation: enrichedConversation,
          };
          if (msg.cwd) replyMsg.cwd = msg.cwd;

          // Persist to group history BEFORE sending (avoids race with history refresh)
          if ((conversation?.type === "group" || conversation?.type === "single") && conversation.groupId) {
            this.db.addGroupMessage(conversation.groupId, fromName, msg.payload?.message || "", []);
          }

          // Group replies: broadcast to all members so everyone sees it in real-time
          // DM replies: send to original sender only
          if (conversation?.type === "group" && conversation.groupId) {
            this.broadcastToGroup(conversation.groupId, replyMsg as unknown as ServerMessage, [agentId]);

            // Track collaboration turns if there's an active collaboration in this group
            this.trackCollaborationTurn(conversation.groupId, fromName, msg.payload?.message || "");
          } else {
            this.sendToAgent(targetId, replyMsg as unknown as ServerMessage);
          }

          // Log reply with latency
          const sendTs = this.sendTimestamps.get(msg.requestId);
          const latencyMs = sendTs ? Date.now() - sendTs : undefined;
          this.db.logMessage({
            requestId: msg.requestId,
            fromName,
            fromDomain: conn?.domain,
            toName: targetAgent?.name,
            toDomain: targetAgent?.domain ?? undefined,
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
        const targetId = this.router.resolveReplyTarget(msg.requestId);
        const conversation = this.router.getConversation(msg.requestId);
        if (targetId) {
          const conn = this.connections.get(agentId);
          const fromName = conn?.name || "unknown";
          const chunkMsg = {
            type: "a2a_stream_chunk" as const,
            requestId: msg.requestId,
            from: { name: fromName, domain: conn?.domain, status: "online" as const },
            delta: msg.delta,
            conversation,
          };
          // Send stream chunk to original sender only (streaming is per-session, no broadcast)
          if (conversation?.type === "group" && conversation.groupId) {
            this.broadcastToGroup(conversation.groupId, chunkMsg, [agentId]);
          } else {
            this.sendToAgent(targetId, chunkMsg);
          }
        }
        return;
      }

      // ── Streaming reply end ────────────────────────────────────────────
      if (msg.type === "a2a_reply_end") {
        const targetId = this.router.resolveReplyTarget(msg.requestId);
        const conversation = this.router.getConversation(msg.requestId);
        if (targetId) {
          const conn = this.connections.get(agentId);
          const fromName = conn?.name || "unknown";
          const cancelled = msg.cancelled === true;
          const endMsg: Record<string, unknown> = {
            type: "a2a_stream_end" as const,
            requestId: msg.requestId,
            from: { name: fromName, domain: conn?.domain, status: "online" as const },
            conversation,
          };
          if (msg.cwd) endMsg.cwd = msg.cwd;
          if (cancelled) endMsg.cancelled = true;
          // Persist to group history BEFORE sending (avoids race with history refresh).
          // Cancelled replies still persist their partial content (the user wants
          // to keep what was streamed before the interrupt) but stamp cancelled_at
          // so the dashboard can render the "⏹ 已中断" footer on reload.
          if ((conversation?.type === "group" || conversation?.type === "single") && conversation.groupId) {
            const msgId = this.db.addGroupMessage(
              conversation.groupId,
              fromName,
              msg.payload?.message || "",
              [],
              cancelled ? { cancelledAt: new Date().toISOString() } : undefined,
            );
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
                  cp.generatedAt ?? new Date().toISOString(),
                  cp.promptVersion ?? "unknown",
                );
              } catch (err: any) {
                this.logger.warn(`[mesh] Failed to persist composedPrompt for msgId=${msgId}: ${err.message}`);
              }
            }
          }

          // Group stream end: broadcast to all members
          if (conversation?.type === "group" && conversation.groupId) {
            this.broadcastToGroup(conversation.groupId, endMsg as unknown as ServerMessage, [agentId]);
            // 流式结束同样计入协作轮次贡献 —— 但中断的回复不算贡献,
            // 否则会让协作轮次在 agent 还没真正表达完整观点时误推进。
            if (!cancelled) {
              this.trackCollaborationTurn(conversation.groupId, fromName, msg.payload?.message || "");
            }
          } else {
            this.sendToAgent(targetId, endMsg as unknown as ServerMessage);
          }

          // Log complete reply with latency
          const sendTs = this.sendTimestamps.get(msg.requestId);
          const latencyMs = sendTs ? Date.now() - sendTs : undefined;
          const targetAgent = this.db.getAgentById(targetId);
          this.db.logMessage({
            requestId: msg.requestId,
            fromName,
            fromDomain: conn?.domain,
            toName: targetAgent?.name,
            toDomain: targetAgent?.domain ?? undefined,
            routeType: "reply",
            direction: "reply",
            payload: JSON.stringify(msg.payload),
            status: cancelled ? "cancelled" : "replied",
            latencyMs,
            groupId: conversation?.groupId,
            source: "ws",
          });
          if (cancelled) {
            this.logger.info(`[mesh] Reply ${msg.requestId} from ${fromName} cancelled mid-stream`);
          }
        } else {
          this.logger.warn(`[mesh] Stream-end target not found for requestId=${msg.requestId}`);
        }
        return;
      }

      // ── Update info (live metadata push) ─────────────────────────────
      if (msg.type === "update_info") {
        const conn = this.connections.get(agentId);
        if (!conn) return;

        // Agent-owned fields: accept description and profile (ignore domain — master-owned)
        if (msg.description !== undefined || msg.profile !== undefined) {
          const meta: { description?: string; profile?: string } = {};
          if (msg.description !== undefined) meta.description = msg.description;
          if (msg.profile !== undefined) meta.profile = JSON.stringify(msg.profile);
          this.db.updateAgentMeta(agentId, meta);
        }
        // domain from agent is IGNORED — master-owned field

        // Broadcast to all agents — domain uses DB value (master-owned)
        const agent = this.db.getAgentById(agentId);
        if (agent) {
          this.broadcastDirectory("update", {
            name: agent.name,
            domain: agent.domain || undefined,
            description: agent.description || undefined,
            status: "online",
            enabled: agent.enabled !== 0,
            profile: parseProfile(agent.profile),
          });
        }

        this.send(ws, { type: "update_info_ack", ok: true });
        this.logger.info(`[mesh] ${conn.name} updated info`);
        return;
      }

      // ── Disconnect ──────────────────────────────────────────────────────
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

        if (status === "in_progress" || status === "completed" || status === "failed" || status === "cancelled") {
          const extra: {
            result?: string;
            errorMessage?: string;
            artifacts?: string[];
            sessionId?: string | null;
            cliTool?: string | null;
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
          // Don't downgrade a cancelled issue back to anything else — but if it
          // arrived after cancellation, still record the event below.
          if (issue.status !== "cancelled") {
            this.db.updateIssueStatus(issueId, status, Object.keys(extra).length > 0 ? extra : undefined);
          }
        }

        this.db.addIssueEvent({
          issueId,
          eventType: status === "in_progress" ? "progress" :
                     status === "completed" ? "completed" :
                     status === "failed" ? "failed" :
                     status === "cancelled" ? "cancelled" : "output",
          agentName: conn.name,
          content: content || "",
          metadata: msg.cwd ? { ...(metadata || {}), cwd: msg.cwd } : metadata,
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

      // ── Session management responses (Executor → Master) ─────────────
      // Workers answer view / delete requests routed via routeToExecutor.
      // First response wins — late responses (from other workers, if any)
      // are dropped. List does NOT go through here; it reads
      // `sessionSnapshots` synchronously instead.
      if (
        msg.type === "session_view_response" ||
        msg.type === "session_delete_response"
      ) {
        const requestId = (msg as { requestId: string }).requestId;
        const pending = this.pendingSessionRequests.get(requestId);
        if (!pending) {
          this.logger.warn(`[mesh] session response for unknown requestId ${requestId}`);
          return;
        }
        this.pendingSessionRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(msg);
        return;
      }

      // ── Session snapshot (Executor → Master, unsolicited) ────────────
      // Worker pushes its full SessionStore after auth and after every
      // mutation. Replace the cached entry wholesale — full-array semantics.
      // The dashboard `GET /sessions?groupId=X` reads from this cache.
      if (msg.type === "session_snapshot") {
        if (!agentId) return;
        this.sessionSnapshots.set(agentId, msg.entries);
        return;
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (agentId) this.handleDisconnect(agentId, connGeneration, "connection_lost");
    });

    ws.on("error", (err) => {
      this.logger.warn(`[mesh] WS error:`, err.stack || err.message);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Disconnect handling (generation-aware — prevents stale events from kicking new connections)
  // ═══════════════════════════════════════════════════════════════════════════

  private handleDisconnect(agentId: string, generation: number, reason: string): void {
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sending
  // ═══════════════════════════════════════════════════════════════════════════

  /** Send a message to a connected agent. Returns false if not connected. */
  sendToAgent(agentId: string, msg: ServerMessage): boolean {
    const conn = this.connections.get(agentId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    this.send(conn.ws, msg);
    return true;
  }

  /**
   * Broadcast a message to all group members EXCEPT those in excludeAgentIds.
   * Used for group message visibility — messages/replies are broadcast so all
   * group members see them in real-time.
   */
  private broadcastToGroup(groupId: string, msg: ServerMessage, excludeAgentIds: string[] = []): void {
    const members = this.db.getGroupMembers(groupId);
    const delivered: { name: string; sent: boolean }[] = [];
    for (const member of members) {
      const memberAgent = this.db.getAgentByName(member.agent_name);
      if (!memberAgent) continue;
      if (excludeAgentIds.includes(memberAgent.id)) continue;
      const ok = this.sendToAgent(memberAgent.id, msg);
      delivered.push({ name: member.agent_name, sent: ok });
    }
    // 流式 chunk 广播会每 chunk 调一次，记日志只会刷屏，跳过；其他类型
    // （a2a_send 等）的广播日志保留，方便排查投递问题。
    const isStreamingChunk = msg.type === "a2a_stream_chunk";
    if (!isStreamingChunk) {
      this.logger.info(`[mesh] broadcastToGroup ${groupId}: ${delivered.length} members, results=${JSON.stringify(delivered)}`);
    }
  }

  /**
   * Public entry point for broadcasting a group message from outside the hub
   * (e.g. REST handlers in api/groups.ts). Thin wrapper over the private
   * broadcastToGroup — keeps the internal helper encapsulated.
   */
  public broadcastToGroupPublic(
    groupId: string,
    msg: ServerMessage,
    excludeAgentIds: string[] = [],
  ): void {
    this.broadcastToGroup(groupId, msg, excludeAgentIds);
  }

  /**
   * 发一条 sender=system 的群消息：入库 + 实时广播给在线群成员。
   * 用于协作流转类消息（启动 / 进入下一轮 / 结束），让群里所有人同步看到状态。
   * - excludeAgentNames：不往这些成员的 WS 推，但消息仍然入库。用于避免 @ 的对象被双触发。
   * - ensureRecipientNames：保证这些 agent 能收到（即便它不在群成员里）。
   *   用于 mention 了非群成员（如协作 firstParticipant 不在群里）的场景。
   */
  postSystemToGroup(
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

    // 2) 保证这些 recipient 收到（即便它不在群里）；与 broadcast 去重
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
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Session management routing (Master → Executor)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Aggregate every connected worker's cached SessionStore snapshot and return
   * only entries belonging to `groupId`. Deduplicates by `(cliTool, sessionId)`
   * — in single-worker-per-cliTool deployments this is a no-op, but if two
   * workers with the same cliTool both claim an entry we keep the first one.
   *
   * This is the fast path for `GET /sessions?groupId=X`: no WS broadcast, no
   * waiting on worker responses. The cache is kept fresh by workers pushing
   * `session_snapshot` after auth and after every mutation.
   */
  listSessionsByGroup(groupId: string): SessionEntry[] {
    const seen = new Set<string>();
    const out: SessionEntry[] = [];
    for (const entries of this.sessionSnapshots.values()) {
      for (const entry of entries) {
        if (entry.groupId !== groupId) continue;
        const key = `${entry.cliTool}:${entry.sessionId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Send a request to one or more online workers matching `predicate` and
   * return the **first** response received within `timeoutMs`. Other responses
   * (including late ones) are dropped.
   *
   * Used by /sessions endpoints:
   *   - view:   predicate = cliTool match,        timeoutMs = 5s
   *   - delete: predicate = cliTool match,        timeoutMs = 5s
   *
   * Rejects with a TimeoutError if no worker answers in time. The HTTP layer
   * maps that to a 504.
   */
  routeToExecutor(
    predicate: (conn: ConnectedAgent) => boolean,
    payload: ServerMessage & { requestId: string },
    timeoutMs = 5_000,
  ): Promise<ClientSessionViewResponse | ClientSessionDeleteResponse> {
    const targets = [...this.connections.values()].filter(
      (c) => c.ws.readyState === WebSocket.OPEN && predicate(c),
    );
    if (targets.length === 0) {
      return Promise.reject(new Error("no matching executor online"));
    }
    return new Promise<ClientSessionViewResponse | ClientSessionDeleteResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSessionRequests.delete(payload.requestId);
        reject(new Error(`executor did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingSessionRequests.set(payload.requestId, { resolve, reject, timer });
      for (const conn of targets) {
        this.send(conn.ws, payload);
      }
    });
  }



  // ═══════════════════════════════════════════════════════════════════════════
  // Directory
  // ═══════════════════════════════════════════════════════════════════════════

  getDirectory(): AgentInfo[] {
    return this.db.listAgents().map((a) => ({
      name: a.name,
      domain: a.domain || undefined,
      description: a.description || undefined,
      status: a.status as "online" | "offline",
      enabled: a.enabled !== 0,
      profile: parseProfile(a.profile),
    }));
  }

  /** Push a config_update to a specific connected Agent (called by API layer). */
  pushConfigUpdate(agentId: string, config: { domain?: string; enabled?: boolean }): boolean {
    const conn = this.connections.get(agentId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;

    // Update in-memory connection state
    if (config.domain !== undefined) conn.domain = config.domain;

    this.send(conn.ws, { type: "config_update", ...config });
    this.logger.info(`[mesh] Pushed config_update to ${conn.name}: ${JSON.stringify(config)}`);
    return true;
  }

  /** Read agent from DB and broadcast directory_update to all connected agents. */
  broadcastAgentUpdate(agentId: string): void {
    const agent = this.db.getAgentById(agentId);
    if (!agent) return;
    this.broadcastDirectory("update", {
      name: agent.name,
      domain: agent.domain || undefined,
      description: agent.description || undefined,
      status: agent.status as "online" | "offline",
      enabled: agent.enabled !== 0,
      profile: parseProfile(agent.profile),
    });
  }

  private broadcastDirectory(event: "join" | "leave" | "update", agent: AgentInfo): void {
    const msg: ServerMessage = { type: "directory_update", event, agent };
    for (const conn of this.connections.values()) {
      this.send(conn.ws, msg);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Issue system (task coordination)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Push issue assignment notification to a specific executor agent. */
  pushIssueAssignment(issueId: string, agentName: string): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue) return false;
    const agent = this.db.getAgentByName(agentName);
    if (!agent) return false;
    return this.sendToAgent(agent.id, {
      type: "issue_assigned",
      issueId: issue.id,
      groupId: issue.group_id,
      title: issue.title,
      description: issue.description,
      workingDir: issue.working_dir || undefined,
      slashCommand: issue.slash_command || undefined,
      approvalPolicy: normalizeApprovalPolicy(issue.approval_policy),
    } as ServerMessage);
  }

  /**
   * Push the user's approval decision to the worker that owns the parked
   * codex JSON-RPC request. Returns false when the issue has no assignee or
   * the assignee is offline (REST layer should still record the decision so
   * it sticks once the agent reconnects).
   */
  pushApprovalResponse(issueId: string, approvalId: string, decision: "accept" | "deny", feedback?: string): boolean {
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
  }

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
  pushChatCancel(agentName: string, requestId: string, reason?: string): boolean {
    const agent = this.db.getAgentByName(agentName);
    if (!agent) return false;
    return this.sendToAgent(agent.id, {
      type: "chat_cancelled",
      requestId,
      agentName,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Push a user-supplied follow-up prompt to the assigned worker so it can
   * spawn its CLI with `--resume <sessionId>` (or start fresh when sessionId
   * is missing) and continue the conversation. Returns false when the issue
   * has no assignee or the assignee is offline.
   */
  pushIssueContinue(issueId: string, prompt: string): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue?.assigned_to) return false;
    const agent = this.db.getAgentByName(issue.assigned_to);
    if (!agent) return false;
    return this.sendToAgent(agent.id, {
      type: "issue_continue",
      issueId,
      groupId: issue.group_id,
      prompt,
      sessionId: issue.session_id || undefined,
      workingDir: issue.working_dir || undefined,
      slashCommand: issue.slash_command || undefined,
      approvalPolicy: normalizeApprovalPolicy(issue.approval_policy),
    });
  }

  /**
   * Push an append-while-active prompt. Worker queues it onto the running
   * task and consumes the queue when the current CLI invocation finishes
   * (continuing with --resume <sessionId> if one is available). Distinct
   * from pushIssueContinue, which the master only fires AFTER the issue
   * has reached completed/failed.
   */
  pushIssueAppend(issueId: string, prompt: string): boolean {
    const issue = this.db.getIssueById(issueId);
    if (!issue?.assigned_to) return false;
    const agent = this.db.getAgentByName(issue.assigned_to);
    if (!agent) return false;
    return this.sendToAgent(agent.id, {
      type: "issue_append",
      issueId,
      groupId: issue.group_id,
      prompt,
      sessionId: issue.session_id || undefined,
      workingDir: issue.working_dir || undefined,
      slashCommand: issue.slash_command || undefined,
      approvalPolicy: normalizeApprovalPolicy(issue.approval_policy),
    });
  }

  /** Broadcast to all connected agents that a new issue is available. */
  notifyNewIssue(issueId: string, groupId: string, title: string, createdBy: string): void {
    const msg = {
      type: "issue_created" as const,
      issueId, groupId, title, createdBy,
    };
    for (const conn of this.connections.values()) {
      this.send(conn.ws, msg);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Collaboration system (multi-agent collaboration tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Notify the issue's group of a change so dashboards can refresh without
   * polling. Safe to call after any DB write touching the issue.
   */
  notifyIssueChanged(issueId: string, groupId: string, kind: "created" | "updated" | "event_appended" | "deleted"): void {
    if (!groupId) return;
    this.broadcastToGroup(groupId, { type: "issue_changed", issueId, groupId, kind });
  }

  /**
   * Send a message on behalf of an agent, mirroring the WS `a2a_send` path
   * for HTTP/CLI callers. If `groupId` is provided the message is treated as
   * a group message: routed to `target` and recorded in group history.
   */
  sendAsAgent(opts: {
    fromName: string;
    target: string;
    message: string;
    groupId?: string;
    groupName?: string;
  }): { requestId: string; delivered: boolean; queued: boolean; error?: string } {
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
    if (result.targetAgentId) {
      const enrichedConversation = this.enrichConversationWithCollaboration(conversation);
      const wireMsg = {
        type: "a2a_message" as const,
        requestId,
        from: { name: opts.fromName, domain: fromAgent.domain || undefined, status: "online" as const },
        payload: { message: opts.message },
        routeType: "exact" as const,
        conversation: enrichedConversation,
      };
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
        // 排除列表含 target 防重复推送。
        this.broadcastToGroup(opts.groupId, wireMsg, [fromAgent.id, result.targetAgentId]);

        const mentions = opts.message.match(/@([\w一-鿿][\w.一-鿿-]*)/g)?.map((m) => m.slice(1)) || [];
        this.db.addGroupMessage(opts.groupId, opts.fromName, opts.message, mentions);
        this.trackCollaborationTurn(opts.groupId, opts.fromName, opts.message);
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

    return { requestId, delivered, queued };
  }

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
  private enrichConversationWithCollaboration<T extends { type?: string; groupId?: string } | undefined>(
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
      return { ...conversation, activeIssues, workingDir } as T;
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
  }

  /** Track a group message as a collaboration turn if applicable. */
  private trackCollaborationTurn(groupId: string, agentName: string, content?: string): void {
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
          this.concludeCollaboration(collab, participants);
        } else {
          // Advance to next round
          this.db.advanceCollaborationRound(collab.id, participants);
          const nextRound = currentRound + 1;

          // 协作式：不再主动广播 collaboration_started 给所有参与者；
          // 由最近发言的 agent 通过 @ 显式选择下一个发言人。
          this.postSystemToGroup(groupId, `🔁 [协作进展] 协作任务「${collab.title}」进入第 ${nextRound}/${maxRounds} 轮，等待当前发言人 @ 下一位或主动结束。`);
          this.notifyIssueChanged(collab.id, groupId, "updated");

          this.logger.info(`[mesh] Collaboration "${collab.title}" advanced to round ${nextRound}`);
        }
      }
    }
  }

  /** Conclude a collaboration by generating a summary from all turns. */
  private concludeCollaboration(collab: { id: string; title: string; group_id: string; max_rounds: number | null; owner: string | null }, participants: string[]): void {
    const events = this.db.getIssueEvents(collab.id);
    const turnEvents = events.filter((e) => e.event_type === "collaboration_turn");

    // Build a simple summary from the collected turns
    const turnSummary = turnEvents.map((e) => `${e.agent_name}: ${e.content}`).join("\n");
    const summary = `协作任务「${collab.title}」已完成，共 ${collab.max_rounds ?? 0} 轮。\n\n参与者的贡献：\n\n${turnSummary}`;

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
    const ownerLine = collab.owner ? `负责人：${collab.owner}` : "无负责人";
    this.postSystemToGroup(collab.group_id, `🏁 [协作完成] 协作任务「${collab.title}」已完成，共 ${collab.max_rounds ?? 0} 轮协作。${ownerLine}`);
    this.notifyIssueChanged(collab.id, collab.group_id, "updated");

    this.logger.info(`[mesh] Collaboration concluded: "${collab.title}" (${collab.id})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Info
  // ═══════════════════════════════════════════════════════════════════════════

  getOnlineCount(): number {
    return this.connections.size;
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    // Close all connections
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1001, "Server shutting down");
      }
    }
    this.connections.clear();
    this.wss.close();
  }
}

function parseProfile(raw: string | null | undefined): AgentProfile | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AgentProfile;
  } catch {
    return undefined;
  }
}

/** 把 DB 里宽松的 string 收敛成协议枚举。脏数据/空值统一回落到 'r_allow'，
 *  避免 worker 端把未知值当成 bypass。 */
function normalizeApprovalPolicy(raw: string | null | undefined): "r_allow" | "rw_allow" {
  return raw === "rw_allow" ? "rw_allow" : "r_allow";
}
