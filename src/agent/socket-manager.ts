/**
 * Digital Employee Mesh — Agent Socket Manager
 *
 * Manages the full connection lifecycle:
 * - Multi-URL failover (round-robin)
 * - Auth handshake (token + JWT reconnect)
 * - Heartbeat (10s interval)
 * - Reconnect with exponential backoff (1s → 30s)
 * - Message dispatching to handlers
 */

import os from "node:os";
import { randomUUID } from "node:crypto";
import { WSClient } from "./ws-client.js";
import type {
  ClientMessage,
  ServerMessage,
  AgentInfo,
  AgentProfile,
  OfflineMsg,
} from "../shared/protocol.js";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  PROTOCOL_VERSION,
} from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Master WebSocket URL(s) — e.g. ["ws://master:18800/ws"] */
  masterUrls: string[];
  /** Agent name (must match registered name on Master) */
  name: string;
  /** Registration token */
  token: string;
  /** Optional description */
  description?: string;
  /** Structured profile (position, responsibilities, tech_stack) */
  profile?: AgentProfile;
  /** Domain for isolation (e.g. "finance", "hr") */
  domain?: string;
  /** Agent endpoint for direct access, e.g. "ws://127.0.0.1:18789" */
  endpoint?: string;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

export interface SocketManagerHandlers {
  onConnected?: (directory: AgentInfo[]) => void;
  onDisconnected?: (reason: string) => void;
  onMessage?: (msg: ServerMessage) => void;
  onOfflineMessages?: (msgs: OfflineMsg[]) => void;
  onDirectoryUpdate?: (event: "join" | "leave" | "update", agent: AgentInfo) => void;
  onConfigUpdate?: (config: { domain?: string; enabled?: boolean }) => void;
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
// Socket Manager
// ---------------------------------------------------------------------------

export class SocketManager {
  private client: WSClient | null = null;
  private urlIndex = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** JWT received from Master — used for fast reconnect */
  private jwt: string | null = null;
  private running = false;
  private instanceId = randomUUID();

  constructor(
    private config: AgentConfig,
    private handlers: SocketManagerHandlers,
    private logger: Logger,
  ) {
    // Ensure URLs end with /ws
    this.config.masterUrls = config.masterUrls.map((url) => {
      if (url.endsWith("/ws")) return url;
      return url.replace(/\/$/, "") + "/ws";
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();

    if (this.client) {
      // Send graceful disconnect
      this.client.send({ type: "disconnect" });
      this.client.close();
      this.client = null;
    }
  }

  /** Send a message to Master. Returns false if not connected. */
  send(msg: ClientMessage): boolean {
    return this.client?.send(msg) ?? false;
  }

  /** Push updated info to Master without reconnecting. Domain is master-owned and not sent. */
  updateInfo(info: { description?: string }): boolean {
    return this.send({
      type: "update_info",
      description: info.description,
    });
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Connection
  // ═══════════════════════════════════════════════════════════════════════════

  private connect(): void {
    if (!this.running) return;

    const url = this.config.masterUrls[this.urlIndex];
    this.logger.info?.(`[mesh-agent] Connecting to ${url}...`);

    this.client = new WSClient(url);

    this.client.on("open", () => {
      this.logger.info?.(`[mesh-agent] Connected, authenticating...`);
      this.authenticate();
    });

    this.client.on("close", (_code, reason) => {
      this.clearTimers();
      this.handlers.onDisconnected?.(reason);
      this.scheduleReconnect();
    });

    this.client.on("error", (err) => {
      this.logger.warn?.(`[mesh-agent] Connection error: ${err.message}`);
    });

    this.client.on("message", (msg) => this.handleMessage(msg));

    this.client.connect();
  }

  private authenticate(): void {
    this.send({
      type: "auth",
      version: PROTOCOL_VERSION,
      token: this.config.token,
      // Include JWT for fast reconnect (Master can skip token verification)
      jwt: this.jwt || undefined,
      name: this.config.name,
      description: this.config.description,
      profile: this.config.profile,
      instance: {
        instanceId: this.instanceId,
        hostname: os.hostname(),
        platform: `${os.platform()}-${os.arch()}`,
        endpoint: this.config.endpoint,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Message handling
  // ═══════════════════════════════════════════════════════════════════════════

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "auth_ok":
        // Store JWT for future reconnects
        this.jwt = msg.jwt;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        // Apply master-assigned config (domain, enabled)
        if (msg.config) {
          if (msg.config.domain !== undefined) this.config.domain = msg.config.domain;
          this.handlers.onConfigUpdate?.(msg.config);
        }
        this.logger.info?.(`[mesh-agent] Authenticated as "${this.config.name}". Directory: ${msg.directory.length} agents`);
        this.handlers.onConnected?.(msg.directory);
        break;

      case "auth_fail":
        this.logger.error?.(`[mesh-agent] Auth failed: ${msg.reason}`);
        // Clear JWT on auth failure (it may have expired)
        this.jwt = null;
        this.client?.close();
        break;

      case "heartbeat_ack":
      case "update_info_ack":
        // Nothing to do
        break;

      case "offline_messages":
        this.logger.info?.(`[mesh-agent] Received ${msg.messages.length} offline messages`);
        this.handlers.onOfflineMessages?.(msg.messages);
        break;

      case "directory_update":
        this.handlers.onDirectoryUpdate?.(msg.event, msg.agent);
        break;

      case "config_update":
        // Master pushed config changes (domain, enabled)
        if (msg.domain !== undefined) this.config.domain = msg.domain;
        this.logger.info?.(`[mesh-agent] Received config_update: ${JSON.stringify({ domain: msg.domain, enabled: msg.enabled })}`);
        this.handlers.onConfigUpdate?.({ domain: msg.domain, enabled: msg.enabled });
        break;

      default:
        // a2a_message, route_result, group_history_response — pass to generic handler
        this.handlers.onMessage?.(msg);
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Heartbeat
  // ═══════════════════════════════════════════════════════════════════════════

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reconnect (exponential backoff + jitter + URL rotation)
  // ═══════════════════════════════════════════════════════════════════════════

  private scheduleReconnect(): void {
    if (!this.running) return;

    // Rotate URL
    this.urlIndex = (this.urlIndex + 1) % this.config.masterUrls.length;

    // Exponential backoff with jitter
    const base = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS,
    );
    const jitter = Math.random() * base * 0.3; // ±30% jitter
    const delay = Math.floor(base + jitter);

    this.reconnectAttempts++;
    this.logger.info?.(`[mesh-agent] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
