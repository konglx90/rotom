/**
 * Digital Employee Mesh — Agent Mode (main entry point)
 *
 * Wires together all agent sub-modules:
 * - SocketManager (connection + heartbeat + reconnect)
 * - Directory (local agent cache)
 * - MessageFilter (allow/block)
 * - InboundDispatcher (message → OpenClaw agent)
 * - OutboundHandler (reply → Master)
 * - MeshToolExecutor (mesh_* tools)
 */

import { SocketManager, type AgentConfig } from "./socket-manager.js";
import { Directory } from "./directory.js";
import { MessageFilter, type FilterConfig } from "./message-filter.js";
import { InboundDispatcher, type InboundDispatcherConfig } from "./inbound-dispatcher.js";
import { OutboundHandler } from "./outbound-handler.js";
import { MeshToolExecutor, MESH_TOOLS } from "./tools.js";
import type {
  ServerMessage,
  ServerA2AMessage,
  AgentInfo,
  OfflineMsg,
} from "../shared/protocol.js";

// ---------------------------------------------------------------------------
// Full agent config
// ---------------------------------------------------------------------------

export interface MeshAgentConfig {
  /** Connection config (master URLs, name, token) */
  connection: AgentConfig;
  /** Local gateway URL for dispatching inbound messages */
  gatewayUrl: string;
  /** Gateway auth token */
  gatewayToken?: string;
  /** Message filter config */
  filter?: FilterConfig;
  /** SSE idle timeout (ms) */
  idleTimeoutMs?: number;
  /** OpenClaw home directory (for session store resolution) */
  openclawHome?: string;
  /** OpenClaw PluginRuntime (channel.routing, channel.reply, system) */
  runtime?: any;
  /** OpenClaw config object */
  cfg?: any;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Agent Mode
// ---------------------------------------------------------------------------

export class AgentMode {
  private socket: SocketManager;
  private directory: Directory;
  private filter: MessageFilter;
  private dispatcher: InboundDispatcher;
  private outbound: OutboundHandler;
  private toolExecutor: MeshToolExecutor;

  constructor(
    private config: MeshAgentConfig,
    private logger: Logger,
  ) {
    this.directory = new Directory();
    this.filter = new MessageFilter(config.filter);

    // Socket manager
    this.socket = new SocketManager(
      config.connection,
      {
        onConnected: (dir) => this.handleConnected(dir),
        onDisconnected: (reason) => this.handleDisconnected(reason),
        onMessage: (msg) => this.handleMessage(msg),
        onOfflineMessages: (msgs) => this.handleOfflineMessages(msgs),
        onDirectoryUpdate: (event, agent) => this.directory.update(event, agent),
        onConfigUpdate: (cfg) => this.handleConfigUpdate(cfg),
      },
      logger,
    );

    // Outbound handler
    this.outbound = new OutboundHandler(this.socket);

    // Inbound dispatcher
    this.dispatcher = new InboundDispatcher(
      {
        gatewayUrl: config.gatewayUrl,
        gatewayToken: config.gatewayToken,
        idleTimeoutMs: config.idleTimeoutMs,
        selfName: config.connection.name,
        openclawHome: config.openclawHome,
        runtime: config.runtime,
        cfg: config.cfg,
      },
      this.filter,
      (requestId, reply) => this.outbound.reply(requestId, reply),
      logger,
      (requestId, delta) => this.outbound.replyChunk(requestId, delta),
      (requestId, fullReply) => this.outbound.replyEnd(requestId, fullReply),
    );

    // Tool executor
    this.toolExecutor = new MeshToolExecutor(this.socket, this.directory, config.connection.name);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════

  start(): void {
    this.socket.start();
    this.logger.info?.("[mesh-agent] Starting...");
  }

  stop(): void {
    this.dispatcher.stop();
    this.toolExecutor.stop();
    this.socket.stop();
    this.logger.info?.("[mesh-agent] Stopped");
  }

  /** Get tool definitions for OpenClaw registration. */
  getToolDefinitions(): typeof MESH_TOOLS {
    return MESH_TOOLS;
  }

  /** Execute a mesh tool call. */
  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    return this.toolExecutor.execute(name, args);
  }

  /** Connection status. */
  get connected(): boolean {
    return this.socket.connected;
  }

  /** Directory accessor. */
  getDirectory(): Directory {
    return this.directory;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Event handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleConnected(agents: AgentInfo[]): void {
    this.directory.setAll(agents);
    this.logger.info?.(
      `[mesh-agent] Online. Directory: ${agents.length} agents (${agents.filter((a) => a.status === "online").length} online)`,
    );
  }

  private handleDisconnected(reason: string): void {
    this.logger.warn?.(`[mesh-agent] Disconnected: ${reason}`);
  }

  private handleConfigUpdate(config: { domain?: string; enabled?: boolean }): void {
    this.logger.info?.(`[mesh-agent] Config update from Master: ${JSON.stringify(config)}`);
    // Future: if enabled === false, could pause message processing
  }

  private handleMessage(msg: ServerMessage): void {
    // Let tool executor try first (for pending tool calls)
    if (this.toolExecutor.handleMessage(msg)) return;

    // Dispatch inbound messages to local agent
    if (msg.type === "a2a_message") {
      const a2aMsg = msg as ServerA2AMessage;
      const conv = a2aMsg.conversation;
      const preview = (a2aMsg.payload?.message || "").slice(0, 60);
      this.logger.info?.(`[mesh-agent] Received a2a_message from=${a2aMsg.from?.name} type=${conv?.type ?? "direct"} routeType=${a2aMsg.routeType} preview="${preview}"`);
      // For group messages, only dispatch if @mentioned this agent
      if (conv?.type === "group") {
        const mentionMatch = (a2aMsg.payload?.message || "").match(/^@([\w一-鿿][\w.一-鿿-]*)/);
        if (mentionMatch && mentionMatch[1] !== this.config.connection.name) {
          this.logger.info?.(`[mesh-agent] Skipping group message @${mentionMatch[1]} (not for us, self="${this.config.connection.name}")`);
          return;
        }
        // Broadcast group replies without @: only original sender dispatches
        if (!mentionMatch && a2aMsg.routeType === "reply" && !this.toolExecutor.isSentGroupRequest(a2aMsg.requestId)) {
          this.logger.info?.(`[mesh-agent] Skipping broadcast group reply (not our request)`);
          return;
        }
        this.logger.info?.(`[mesh-agent] Group message accepted (mention=${mentionMatch?.[1] ?? "none"}) → dispatching`);
      }
      this.dispatcher.dispatch(msg);
    } else {
      this.logger.info?.(`[mesh-agent] Ignored message type=${(msg as { type?: string }).type}`);
    }
  }

  private handleOfflineMessages(msgs: OfflineMsg[]): void {
    this.logger.info?.(`[mesh-agent] Processing ${msgs.length} offline messages`);
    for (const om of msgs) {
      // Create a synthetic ServerA2AMessage for the dispatcher
      const synth: ServerA2AMessage = {
        type: "a2a_message",
        requestId: `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        from: om.from,
        payload: om.payload,
        routeType: om.routeType,
      };
      this.dispatcher.dispatch(synth);
    }
  }
}
