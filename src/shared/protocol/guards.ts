/**
 * Runtime type guards for the mesh protocol.
 *
 * `isClientMessage` validates external WS input at the auth boundary (master
 * connection handler). `isServerMessage` is provided for symmetry — workers
 * that want to validate incoming master frames can use it.
 */

import type { ClientMessage } from "./client-messages.js";
import type { ServerMessage } from "./server-messages.js";

export function isClientMessage(x: unknown): x is ClientMessage {
  if (!x || typeof x !== "object") return false;
  const msg = x as Record<string, unknown>;
  if (typeof msg.type !== "string") return false;
  switch (msg.type) {
    case "auth":
      // token 在 OPC 本机模式下可空(master 端 isLoopback 信任直通);
      // 跨机连接远程 master 时由 authenticate() 校验。
      return typeof msg.name === "string"
        && (msg.token === undefined || msg.token === null || typeof msg.token === "string");
    case "heartbeat":
      return true;
    case "a2a_send":
      return typeof msg.requestId === "string" && !!msg.payload;
    case "a2a_reply":
      return typeof msg.requestId === "string" && !!msg.payload;
    case "a2a_reply_chunk":
      return typeof msg.requestId === "string" && typeof msg.delta === "string";
    case "a2a_reply_end":
      return typeof msg.requestId === "string" && !!msg.payload;
    case "update_info":
      return true;
    case "disconnect":
      return true;
    case "issue_update":
      return typeof msg.issueId === "string" && typeof msg.status === "string";
    case "issue_todos_update":
      return typeof msg.issueId === "string" && Array.isArray(msg.todos);
    case "issue_usage_progress":
      return typeof msg.issueId === "string" && !!msg.usage;
    case "subscribe_issue_detail":
      return typeof msg.issueId === "string";
    case "unsubscribe_issue_detail":
      return typeof msg.issueId === "string";
    case "issue_approval_request":
      return typeof msg.issueId === "string"
        && typeof msg.approvalId === "string"
        && (msg.kind === "exec" || msg.kind === "file_change" || msg.kind === "plan" || msg.kind === "ask")
        && typeof msg.summary === "string";
    case "session_view_response":
      return typeof msg.requestId === "string"
        && typeof msg.groupId === "string"
        && typeof msg.sessionId === "string"
        && (msg.format === "jsonl" || msg.format === "text" || msg.format === "raw")
        && typeof msg.content === "string";
    case "session_delete_response":
      return typeof msg.requestId === "string"
        && typeof msg.groupId === "string"
        && typeof msg.sessionId === "string"
        && typeof msg.ok === "boolean";
    case "session_snapshot":
      return Array.isArray(msg.entries);
    case "session_invalidated":
      return typeof msg.cliTool === "string"
        && typeof msg.groupId === "string"
        && typeof msg.sessionId === "string";
    default:
      return false;
  }
}

const SERVER_MESSAGE_TYPES = new Set([
  "auth_ok", "auth_fail", "heartbeat_ack",
  "a2a_message", "route_result", "directory_update", "offline_messages",
  "update_info_ack", "config_update", "a2a_stream_chunk", "a2a_stream_end",
  "issue_created", "issue_assigned", "issue_update_ack",
  "issue_approval_response", "issue_cancelled", "chat_cancelled",
  "issue_changed", "issue_continue", "issue_append", "issue_interrupt",
  "issue_usage_progress",
  "session_view_request", "session_delete_request", "session_sync_push",
]);

export function isServerMessage(x: unknown): x is ServerMessage {
  if (!x || typeof x !== "object") return false;
  const msg = x as Record<string, unknown>;
  if (typeof msg.type !== "string") return false;
  return SERVER_MESSAGE_TYPES.has(msg.type);
}
