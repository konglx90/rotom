/**
 * Digital Employee Mesh — Inbound Dispatcher
 *
 * Receives a2a_message from Master → dispatches to local OpenClaw agent
 * via OpenClaw Plugin SDK (channel.routing + channel.reply).
 *
 * Flow: a2a_message → dedup → filter → SDK dispatch → collect reply → callback
 */

import type { ServerA2AMessage } from "../shared/protocol.js";
import { injectGroupContext } from "../shared/group-context.js";
import { MessageDedup } from "../shared/dedup.js";
import { MAX_CONCURRENT_DISPATCHES } from "../shared/constants.js";
import type { MessageFilter } from "./message-filter.js";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface InboundDispatcherConfig {
  /** Local gateway URL (e.g. "http://127.0.0.1:5577") */
  gatewayUrl: string;
  /** Gateway auth token (if required) */
  gatewayToken?: string;
  /** Idle timeout for SSE stream (ms, default 120s) */
  idleTimeoutMs?: number;
  /** Agent ID used for routing (default: "a2a") */
  agentId?: string;
  /** OPENCLAW_HOME or config path for resolving session store */
  openclawHome?: string;
  /** Our own agent name — used to filter self-addressed messages */
  selfName?: string;
  /** OpenClaw PluginRuntime (channel.routing, channel.reply, system) */
  runtime?: any;
  /** OpenClaw config object */
  cfg?: any;
}

// ---------------------------------------------------------------------------
// Reply callback
// ---------------------------------------------------------------------------

export type ReplyCallback = (requestId: string, reply: string) => void;
export type ReplyChunkCallback = (requestId: string, delta: string) => void;
export type ReplyEndCallback = (requestId: string, fullReply: string) => void;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Inbound Dispatcher
// ---------------------------------------------------------------------------

export class InboundDispatcher {
  private dedup = new MessageDedup();
  private activeDispatches = 0;
  private cleanupTimer: ReturnType<typeof setInterval>;
  /** Track which peers already have displayName set (avoid repeated writes) */
  private labeledPeers = new Set<string>();

  constructor(
    private config: InboundDispatcherConfig,
    private filter: MessageFilter,
    private onReply: ReplyCallback,
    private logger: Logger,
    private onReplyChunk?: ReplyChunkCallback,
    private onReplyEnd?: ReplyEndCallback,
  ) {
    this.cleanupTimer = setInterval(() => this.dedup.cleanup(), 60_000);
  }

  /** Dispatch an inbound message. Returns immediately (async processing). */
  dispatch(msg: ServerA2AMessage): void {
    // Dedup
    if (this.dedup.isDuplicate(msg.requestId)) {
      this.logger.info?.(`[mesh-dispatch] Duplicate ${msg.requestId}, skipping`);
      return;
    }
    this.dedup.mark(msg.requestId);

    // Filter
    if (!this.filter.accepts(msg.from.name)) {
      this.logger.info?.(`[mesh-dispatch] Filtered message from ${msg.from.name}`);
      return;
    }

    // Drop self-addressed messages (e.g. from offline queue miscounting)
    if (this.config.selfName && msg.from.name === this.config.selfName) {
      this.logger.info?.(`[mesh-dispatch] Dropping self-addressed message ${msg.requestId}`);
      return;
    }

    // Mention filter: if the message starts with @<someone> and that someone
    // isn't us, skip — this is the catch-all that covers the offline-queue
    // path where conversation metadata is missing.
    if (this.config.selfName) {
      const mentionMatch = (msg.payload?.message ?? "").match(/^@([\w一-鿿][\w.一-鿿-]*)/);
      if (mentionMatch && mentionMatch[1] !== this.config.selfName) {
        this.logger.info?.(`[mesh-dispatch] Message ${msg.requestId} addressed to @${mentionMatch[1]}, not us (${this.config.selfName}), skipping`);
        return;
      }
    }

    // Concurrency limit — prevent unbounded parallel SSE calls
    if (this.activeDispatches >= MAX_CONCURRENT_DISPATCHES) {
      this.logger.warn?.(`[mesh-dispatch] Concurrency limit reached (${MAX_CONCURRENT_DISPATCHES}), dropping ${msg.requestId}`);
      return;
    }

    // Dispatch async
    this.activeDispatches++;
    this.processMessage(msg).finally(() => {
      this.activeDispatches--;
    });
  }

  get dispatching(): number {
    return this.activeDispatches;
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════════════════════

  private async processMessage(msg: ServerA2AMessage): Promise<void> {
    const fromLabel = msg.from.domain
      ? `${msg.from.name}@${msg.from.domain}`
      : msg.from.name;

    // Group messages get their own session key for conversation isolation;
    // direct messages use sender name.
    const isGroup = msg.conversation?.type === "group" && msg.conversation.groupId;
    const groupId = isGroup ? msg.conversation!.groupId : undefined;

    // For group messages, prepend group context so the agent knows it's in a group
    let prompt = msg.payload.message;
    if (isGroup) {
      prompt = injectGroupContext(prompt, msg.conversation, this.config.selfName || "(unknown)");

      // Inject collaboration context if this group has an active collaboration.
      const collab = msg.conversation!.collaboration;
      if (collab) {
        const lastRoundBlock = collab.lastRoundTurns.length > 0
          ? `上一轮（第 ${Math.max(collab.currentRound - 1, 0)} 轮）发言全文:\n` +
            collab.lastRoundTurns.map(t => `  - ${t.agentName}: ${t.content}`).join("\n")
          : "（这是第一轮，尚无上一轮内容）";
        const earlierLine = collab.earlierSpeakers.length > 0
          ? `更早轮次已发言的成员: ${collab.earlierSpeakers.join("、")}`
          : "（更早轮次暂无发言）";
        const ownerLine = collab.owner ? `\n负责人: ${collab.owner}` : "";
        const collabBlock =
          `[协作上下文]\n` +
          `IssueId: ${collab.issueId}\n` +
          `任务: ${collab.title}\n` +
          `目标: ${collab.goal}\n` +
          `参与者: ${collab.participants.join("、")}${ownerLine}\n` +
          `当前进度: 第 ${collab.currentRound}/${collab.maxRounds} 轮\n` +
          `${lastRoundBlock}\n` +
          `${earlierLine}\n` +
          `提示: 请基于上一轮发言做"递进"而非重复观点；本轮可以在结尾 @ 下个发言人，或在已达成目标时调用 mesh_conclude_collaboration 结束。轮数越靠后越应聚焦收敛。`;
        prompt = `${collabBlock}\n\n${prompt}`;
      }
    }

    this.logger.info?.(`[mesh-dispatch] Processing ${msg.requestId} from ${fromLabel}${isGroup ? ` (group=${msg.conversation!.groupName})` : ""}`);

    try {
      const reply = await this.callGateway(prompt, msg.from.name, groupId, msg.requestId, msg.payload.message);

      this.ensureSessionDisplayName(msg.from.name);

      if (reply) {
        // If streaming callbacks are available, send replyEnd; otherwise send full reply
        if (this.onReplyChunk && this.onReplyEnd) {
          this.onReplyEnd(msg.requestId, reply);
        } else {
          this.onReply(msg.requestId, reply);
        }
        this.logger.info?.(`[mesh-dispatch] Replied to ${msg.requestId} (${reply.length} chars)`);
      }
    } catch (err: any) {
      console.error('[mesh-dispatch] Error details:', err);
      console.error('[mesh-dispatch] Error type:', typeof err);
      console.error('[mesh-dispatch] Error keys:', Object.keys(err || {}));
      this.logger.error?.(`[mesh-dispatch] Failed ${msg.requestId}:`, err?.stack || err?.message || JSON.stringify(err));
    }
  }

  /**
   * Set displayName on the session entry so the webchat sidebar shows
   * "💬 小山" instead of raw "openai-user:小山".
   *
   * Writes directly to sessions.json (same process, safe to do).
   * Only writes once per peer per dispatcher lifetime.
   */
  private ensureSessionDisplayName(peerName: string): void {
    if (this.labeledPeers.has(peerName)) return;
    this.labeledPeers.add(peerName);

    try {
      const agentId = this.config.agentId ?? "a2a";
      
      // Resolve OpenClaw home directory.
      // Priority: config.openclawHome > OPENCLAW_CONFIG_PATH (derive parent) > OPENCLAW_HOME > ~/.openclaw
      let base: string;
      const explicitHome = this.config.openclawHome ?? process.env.OPENCLAW_HOME;
      if (explicitHome) {
        base = explicitHome.startsWith("~") ? explicitHome.replace("~", process.env.HOME || "") : explicitHome;
      } else {
        const configPath = process.env.OPENCLAW_CONFIG_PATH;
        if (configPath) {
          // OPENCLAW_CONFIG_PATH=~/.openclaw-xiaoshan/openclaw.json → home = ~/.openclaw-xiaoshan
          const resolved = configPath.startsWith("~") ? configPath.replace("~", process.env.HOME || "") : configPath;
          base = path.dirname(resolved);
        } else {
          base = path.join(process.env.HOME || "", ".openclaw");
        }
      }
      const storePath = path.join(base, "agents", agentId, "sessions", "sessions.json");

      if (!fs.existsSync(storePath)) return;

      const raw = fs.readFileSync(storePath, "utf-8");
      const store = JSON.parse(raw) as Record<string, any>;

      // Find the session key for this peer
      const sessionKey = `agent:${agentId}:openai-user:${peerName}`;
      const entry = store[sessionKey];
      if (!entry) return;

      // Only set if not already set
      if (entry.displayName) return;

      entry.displayName = `💬 ${peerName}`;
      // Atomic write: write to temp file then rename to avoid corruption on crash
      const tmpPath = storePath + `.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
      fs.renameSync(tmpPath, storePath);
      this.logger.info?.(`[mesh-dispatch] Set displayName for ${peerName}`);
    } catch (err: any) {
      // Non-fatal: sidebar just shows raw key
      this.logger.warn?.(`[mesh-dispatch] Failed to set displayName for ${peerName}: ${err.message}`);
    }
  }

  private async callGateway(prompt: string, senderName: string, groupId: string | undefined, requestId?: string, rawMessage?: string): Promise<string> {
    const core = this.config.runtime;
    const cfg = this.config.cfg;

    // Check if SDK is available
    if (!core?.channel?.reply?.dispatchReplyFromConfig) {
      this.logger.warn?.(`[mesh-dispatch] OpenClaw SDK not available, cannot dispatch`);
      return "";
    }

    this.logger.info?.(`[mesh-dispatch] Using OpenClaw SDK to dispatch message from ${senderName}`);

    // 1. Resolve route using sender name (ensures correct agentId)
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "a2a-gateway",
      peer: { kind: "dm" as const, id: senderName },
    });

    const agentId = route.agentId;
    // For group messages, override sessionKey to achieve per-group isolation
    const resolvedSessionKey = groupId
      ? `agent:${agentId}:a2a-gateway:group:${groupId}`
      : route.sessionKey;

    this.logger.info?.(`[mesh-dispatch] Route: agentId=${agentId}, sessionKey=${resolvedSessionKey}`);

    // 2. Enqueue system event (notification in sidebar)
    // For group messages, skip the message preview — the full message body follows
    // immediately, so including it here would duplicate content in the agent's view.
    // For direct messages, include a preview since there's no other context.
    const eventText = groupId
      ? `Mesh message from ${senderName} (group)`
      : `Mesh message from ${senderName}: ${(rawMessage || prompt).replace(/\s+/g, " ").slice(0, 160)}`;
    core.system.enqueueSystemEvent(eventText, {
      sessionKey: resolvedSessionKey,
      contextKey: `a2a:message:${Date.now()}`,
    });

    // 3. Format agent envelope
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "A2A Mesh",
      from: senderName,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: prompt,
    });

    // 4. Build inbound context
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: prompt,
      CommandBody: prompt,
      From: `a2a:${senderName}`,
      To: `user:${senderName}`,
      SessionKey: resolvedSessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      SenderName: senderName,
      SenderId: senderName,
      Provider: "a2a-gateway" as const,
      Surface: "a2a-gateway" as const,
      MessageSid: `mesh_${Date.now()}`,
      Timestamp: Date.now(),
      CommandAuthorized: true,
      OriginatingChannel: "a2a-gateway" as const,
      OriginatingTo: `user:${senderName}`,
    });

    // 5. Create reply dispatcher — collect all reply chunks
    let replyText = "";

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: "",
        responsePrefixContextProvider: undefined,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
        onReplyStart: undefined,
        deliver: async (payload: any) => {
          const text = payload.text ?? "";
          if (text.trim()) {
            replyText += text;
            // Stream chunk to sender if streaming is enabled
            if (requestId && this.onReplyChunk) {
              this.logger.info?.(`[mesh-dispatch] Streaming chunk (${text.length} chars) for ${requestId}`);
              this.onReplyChunk(requestId, text);
            }
          }
        },
        onError: (err: any, info: any) => {
          this.logger.error?.(`[mesh-dispatch] SDK reply error (${info?.kind}): ${err}`);
        },
        onIdle: undefined,
      });

    // 6. Dispatch to agent
    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    this.logger.info?.(`[mesh-dispatch] SDK dispatch complete, reply length=${replyText.length}`);
    return replyText;
  }
}
