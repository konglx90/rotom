/**
 * WSHubCore — constructor, lifecycle, heartbeat / cleanup timers, shared types.
 *
 * The class shell here owns the persistent in-memory state (connection map,
 * pending session requests, snapshot cache) and the wss instance. Domain
 * modules (./connection.ts, ./routing.ts, ./collaboration.ts, ...) attach
 * their methods to the WSHub class via `Object.assign(this, ...)` in the
 * composition root (./internal.ts). The `this` inside each method is typed
 * as `WSHubSelf` — a structural shape that exposes the cross-module surface
 * (db, auth, router, offlineQueue, logger, connections, send, etc.).
 *
 * handleConnection is a single 715-line method that owns its own closure
 * state (authenticated flag, agentId, generation). It's deliberately kept
 * intact in ./connection.ts for now — a follow-up PR can split it by
 * msg.type once we have confidence the dispatch + helper boundaries hold.
 */

import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { MeshDb } from "../db/index.js";
import type { AuthService } from "../auth.js";
import type { Router } from "../router.js";
import type { OfflineQueue } from "../offline-queue.js";
import type {
  AgentInfo,
  AgentProfile,
  ClientSessionDeleteResponse,
  ClientSessionViewResponse,
  ServerMessage,
  SessionEntry,
} from "../../shared/protocol.js";
import {
  HEARTBEAT_CHECK_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  CLEANUP_INTERVAL_MS,
  PENDING_REQUEST_TTL_MS,
  WS_MAX_PAYLOAD,
} from "../../shared/constants.js";

// ────────────────────────────────────────────────────────────────────────────
// Shared types
// ────────────────────────────────────────────────────────────────────────────

/** Connected agent state (in-memory only — not persisted). */
export interface ConnectedAgent {
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
  /** Monotonic generation counter — prevents stale close events from kicking new connections. */
  generation: number;
  /** Rate limiting: timestamps of recent messages. */
  messageTimestamps: number[];
}

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Pending session management request awaiting a worker response. */
export type PendingSession = {
  resolve: (msg: ClientSessionViewResponse | ClientSessionDeleteResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Structural surface every domain method sees when typed as `this: WSHubSelf`.
 * Includes both fields declared on WSHubCore and method signatures referenced
 * across modules (e.g. connection.ts needs `send`, `broadcastToGroup`,
 * `broadcastDirectory`, `getDirectory`, `enrichConversationWithCollaboration`,
 * `trackCollaborationTurn`, `logMessage`, etc.).
 */
export interface WSHubSelf {
  readonly db: MeshDb;
  readonly auth: AuthService;
  readonly router: Router;
  readonly offlineQueue: OfflineQueue;
  readonly logger: Logger;

  // Persistent in-memory state
  readonly connections: Map<string, ConnectedAgent>;
  readonly sendTimestamps: Map<string, number>;
  /** Global generation counter — assigned on each successful auth. */
  generation: number;
  readonly pendingSessionRequests: Map<string, PendingSession>;
  readonly sessionSnapshots: Map<string, SessionEntry[]>;

  // ─── Low-level transport ────────────────────────────────────────────────
  /** Send a ServerMessage on a raw ws. No-op if not OPEN. */
  send(ws: WebSocket, msg: ServerMessage): void;
  /** Send to a connected agent by id. Returns false if offline. */
  sendToAgent(agentId: string, msg: ServerMessage): boolean;
  /** Broadcast to all group members except those in excludeAgentIds. */
  broadcastToGroup(groupId: string, msg: ServerMessage, excludeAgentIds?: string[]): void;
  /** Broadcast a directory_update to every connected agent. */
  broadcastDirectory(event: "join" | "leave" | "update", agent: AgentInfo): void;
  /** Read latest directory from DB (used in auth_ok). */
  getDirectory(): AgentInfo[];

  // ─── Message dispatcher ────────────────────────────────────────────────
  /** Top-level message handler — wired in start() to ws.on("connection"). */
  handleConnection(ws: WebSocket): void;
  /** Generation-aware disconnect — keeps stale events from kicking new connections. */
  handleDisconnect(agentId: string, generation: number, reason: string): void;

  // ─── Cross-module message helpers ──────────────────────────────────────
  /** Attach collaboration/workingDir metadata to a conversation payload. */
  enrichConversationWithCollaboration<T extends { type?: string; groupId?: string } | undefined>(
    conversation: T,
    targetAgentName?: string,
  ): T;
  /** Track a group message as a collaboration turn if applicable. */
  trackCollaborationTurn(groupId: string, agentName: string, content?: string): void;
  /** Push a chat-stream cancellation to the responder worker. */
  pushChatCancel(agentName: string, requestId: string, reason?: string): boolean;
  /** Notify the issue's group of a change (called from connection.ts's update_info / issue_update paths). */
  notifyIssueChanged(issueId: string, groupId: string, kind: "created" | "updated" | "event_appended" | "deleted"): void;
  /** Post a system message to a group (used by collaboration conclude/advance). */
  postSystemToGroup(groupId: string, content: string, excludeAgentNames?: string[], ensureRecipientNames?: string[]): void;
  /** Conclude a collaboration (called when a round hits max_rounds). */
  concludeCollaboration(
    collab: { id: string; title: string; group_id: string; max_rounds: number | null; owner: string | null },
    participants: string[],
  ): void;
  /** Re-broadcast directory after an update_info from an agent. */
  broadcastAgentUpdate(agentId: string): void;
}

export class WSHubCore {
  readonly db: MeshDb;
  readonly auth: AuthService;
  readonly router: Router;
  readonly offlineQueue: OfflineQueue;
  readonly logger: Logger;

  private wss: WebSocketServer;
  readonly connections = new Map<string, ConnectedAgent>(); // agentId → conn
  readonly sendTimestamps = new Map<string, number>(); // requestId → send timestamp (for latency)
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  generation = 0; // global generation counter — assigned on each successful auth

  /**
   * In-flight session management requests awaiting a worker response. Keyed
   * by requestId; each entry holds a resolver + a setTimeout that fires
   * routeToExecutor's rejection with a timeout error. Cleaned up in the
   * session response handler (first response wins, except for broadcasts
   * which collect all responses until timeout).
   */
  readonly pendingSessionRequests = new Map<string, PendingSession>();

  /**
   * In-memory cache of each worker's SessionStore. Workers push a
   * `session_snapshot` after auth and after every mutation; we replace the
   * entry on receipt. Powers the dashboard's `GET /sessions?groupId=X`
   * without WS round-trips — fast list, no broadcast.
   *
   * Key is `ConnectedAgent.id` (workerAgentId). On disconnect we drop the
   * entry so offline workers don't surface stale sessions; the next reconnect
   * re-pushes a snapshot.
   */
  readonly sessionSnapshots = new Map<string, SessionEntry[]>();

  constructor(
    httpServer: Server,
    db: MeshDb,
    auth: AuthService,
    router: Router,
    offlineQueue: OfflineQueue,
    logger: Logger,
  ) {
    this.db = db;
    this.auth = auth;
    this.router = router;
    this.offlineQueue = offlineQueue;
    this.logger = logger;
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/ws",
      maxPayload: WS_MAX_PAYLOAD,
    });
  }

  start(): void {
    const self = this as unknown as WSHubSelf;
    this.wss.on("connection", (ws) => self.handleConnection(ws));

    // Periodic heartbeat check
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [agentId, conn] of this.connections) {
        if (conn.ws.readyState !== WebSocket.OPEN || now - conn.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          const reason = conn.ws.readyState !== WebSocket.OPEN ? "ws_closed" : "heartbeat_timeout";
          self.handleDisconnect(agentId, conn.generation, reason);
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

// ────────────────────────────────────────────────────────────────────────────
// Helpers shared across modules
// ────────────────────────────────────────────────────────────────────────────

/** Parse a stored agent profile JSON string. Returns undefined on missing/malformed input. */
export function parseProfile(raw: string | null | undefined): AgentProfile | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AgentProfile;
  } catch {
    return undefined;
  }
}

/**
 * 把 DB 里宽松的 string 收敛成协议枚举。脏数据/空值统一回落到 'r_allow'，
 * 避免 worker 端把未知值当成 bypass。
 */
export function normalizeApprovalPolicy(raw: string | null | undefined): "r_allow" | "rw_allow" {
  return raw === "rw_allow" ? "rw_allow" : "r_allow";
}