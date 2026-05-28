/**
 * Digital Employee Mesh — Constants
 */

/** Protocol version — bump when wire format changes (v2: field ownership + config_update) */
export const PROTOCOL_VERSION = 2;

/** Default Master WebSocket port */
export const DEFAULT_MASTER_PORT = 18800;

/** Default Master bind host */
export const DEFAULT_MASTER_HOST = "0.0.0.0";

/** Agent heartbeat interval (ms) */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Master heartbeat timeout — disconnect if no heartbeat for this long (ms) */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** Master heartbeat check interval (ms) */
export const HEARTBEAT_CHECK_INTERVAL_MS = 30_000;

/** Auth timeout — Agent must authenticate within this time (ms) */
export const AUTH_TIMEOUT_MS = 10_000;

/** JWT expiration */
export const JWT_EXPIRY = "7d";

/** JWT algorithm */
export const JWT_ALGORITHM = "HS256" as const;

/** Offline message TTL (24 hours) */
export const OFFLINE_MESSAGE_TTL_HOURS = 24;

/** Offline message per-agent limit */
export const OFFLINE_MESSAGE_LIMIT = 100;

/** Message dedup TTL (5 minutes) */
export const DEDUP_TTL_MS = 5 * 60 * 1000;

/** Pending request TTL — reply correlation expires after this (5 minutes) */
export const PENDING_REQUEST_TTL_MS = 5 * 60 * 1000;

/** Cleanup interval for dedup and pending requests (60 seconds) */
export const CLEANUP_INTERVAL_MS = 60_000;

/** Agent reconnect base delay (ms) */
export const RECONNECT_BASE_DELAY_MS = 1_000;

/** Agent reconnect max delay (ms) */
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** WebSocket max payload size (1 MB) — prevents OOM from oversized messages */
export const WS_MAX_PAYLOAD = 1_048_576;

/** Per-agent rate limit: max messages per window */
export const RATE_LIMIT_MAX = 60;

/** Rate limit sliding window (ms) */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Audit / message log retention (days) */
export const LOG_RETENTION_DAYS = 30;

/** Max concurrent inbound dispatches per agent */
export const MAX_CONCURRENT_DISPATCHES = 10;

/** WebSocket close codes */
export const WS_CLOSE = {
  AUTH_TIMEOUT: 4001,
  AUTH_FAILED: 4002,
  INVALID_JSON: 4400,
  NOT_AUTHENTICATED: 4401,
  RATE_LIMITED: 4429,
} as const;
