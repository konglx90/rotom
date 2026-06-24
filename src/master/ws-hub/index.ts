/**
 * WS Hub public surface.
 *
 * The full implementation lives in `./internal.ts` while handler-by-handler
 * extraction lands in follow-up PRs (planned: `connection.ts` for the
 * message-dispatch if-chain, `routing.ts` for broadcasts/issue routing,
 * `collaboration.ts` for round tracking).
 */

export { WSHub } from "./internal.js";