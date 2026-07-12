/**
 * WSHub — composition root that wires each domain module's methods onto a
 * single instance. Public API surface (method names) is unchanged from the
 * pre-split monolithic version, so the 29 call sites across
 * `src/master/*.ts` and `tests/*.ts` need no edits.
 *
 * Domain modules (./connection.ts, ./routing.ts, ./directory.ts,
 * ./sessions.ts, ./conversation.ts) export method bags whose `this` is
 * typed as `WSHubSelf` (declared in ./hub.ts) — a structural shape with the
 * cross-module surface (db, auth, router, offlineQueue, logger, connections,
 * send, broadcast, etc.) so methods in one bag can call methods in another.
 *
 * The `declare` lines below are purely type annotations: they tell the
 * TypeScript compiler that the runtime instance (built via Object.assign in
 * the constructor) has every domain method, without forcing us to duplicate
 * signatures. Implementations live in the domain modules.
 */

import type { Server } from "node:http";
import { WSHubCore } from "./hub.js";
import { connectionMethods } from "./connection.js";
import { connectionChatMethods } from "./connection-chat.js";
import { routingMethods } from "./routing.js";
import { directoryMethods } from "./directory.js";
import { sessionsMethods } from "./sessions.js";
import { conversationMethods } from "./conversation.js";
import type { MeshDb } from "../db/index.js";
import type { AuthService } from "../auth.js";
import type { Router } from "../router.js";
import type { OfflineQueue } from "../offline-queue.js";
import type { Logger } from "./hub.js";

export class WSHub extends WSHubCore {
  // ─── connection ──────────────────────────────────────────────────────────
  declare handleConnection: typeof connectionMethods.handleConnection;
  declare handleDisconnect: typeof connectionMethods.handleDisconnect;
  declare handleA2aSend: typeof connectionChatMethods.handleA2aSend;
  declare handleA2aReply: typeof connectionChatMethods.handleA2aReply;
  declare handleA2aReplyChunk: typeof connectionChatMethods.handleA2aReplyChunk;
  declare handleA2aReplyEnd: typeof connectionChatMethods.handleA2aReplyEnd;

  // ─── routing ──────────────────────────────────────────────────────────────
  declare send: typeof routingMethods.send;
  declare sendToAgent: typeof routingMethods.sendToAgent;
  declare broadcastToGroup: typeof routingMethods.broadcastToGroup;
  declare broadcastToGroupPublic: typeof routingMethods.broadcastToGroupPublic;
  declare postSystemToGroup: typeof routingMethods.postSystemToGroup;
  declare pushIssueAssignment: typeof routingMethods.pushIssueAssignment;
  declare pushApprovalResponse: typeof routingMethods.pushApprovalResponse;
  declare pushChatCancel: typeof routingMethods.pushChatCancel;
  declare pushIssueContinue: typeof routingMethods.pushIssueContinue;
  declare pushIssueAppend: typeof routingMethods.pushIssueAppend;
  declare notifyNewIssue: typeof routingMethods.notifyNewIssue;
  declare notifyIssueChanged: typeof routingMethods.notifyIssueChanged;
  declare subscribeIssue: typeof routingMethods.subscribeIssue;
  declare unsubscribeIssue: typeof routingMethods.unsubscribeIssue;
  declare unsubscribeAllIssues: typeof routingMethods.unsubscribeAllIssues;
  declare sendToIssueSubscribers: typeof routingMethods.sendToIssueSubscribers;

  // ─── directory ────────────────────────────────────────────────────────────
  declare getDirectory: typeof directoryMethods.getDirectory;
  declare pushConfigUpdate: typeof directoryMethods.pushConfigUpdate;
  declare broadcastAgentUpdate: typeof directoryMethods.broadcastAgentUpdate;
  declare broadcastDirectory: typeof directoryMethods.broadcastDirectory;
  declare onlineCliTools: typeof directoryMethods.onlineCliTools;

  // ─── sessions ─────────────────────────────────────────────────────────────
  declare listSessionsByGroup: typeof sessionsMethods.listSessionsByGroup;
  declare findSessionEntry: typeof sessionsMethods.findSessionEntry;
  declare routeToExecutor: typeof sessionsMethods.routeToExecutor;

  // ─── conversation ─────────────────────────────────────────────────────────
  declare enrichGroupConversation: typeof conversationMethods.enrichGroupConversation;
  declare checkAndCancelBridgesForMessage: typeof conversationMethods.checkAndCancelBridgesForMessage;
  declare autoCreateBridgeOnMention: typeof conversationMethods.autoCreateBridgeOnMention;
  declare sendAsAgent: typeof conversationMethods.sendAsAgent;

  constructor(
    httpServer: Server,
    db: MeshDb,
    auth: AuthService,
    router: Router,
    offlineQueue: OfflineQueue,
    logger: Logger,
  ) {
    super(httpServer, db, auth, router, offlineQueue, logger);
    // Each method bag's `this` resolves to this instance at call time.
    // The `declare` lines above ensure TypeScript sees these as members.
    Object.assign(this, connectionMethods);
    Object.assign(this, connectionChatMethods);
    Object.assign(this, routingMethods);
    Object.assign(this, directoryMethods);
    Object.assign(this, sessionsMethods);
    Object.assign(this, conversationMethods);
  }
}