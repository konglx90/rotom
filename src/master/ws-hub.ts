/**
 * Backwards-compatible facade for the WebSocket hub.
 *
 * Implementation has moved into `./ws-hub/`:
 *   • `./ws-hub/internal.ts` — WSHub runtime class (still monolithic; handler
 *                              extraction lands in follow-up PRs)
 *   • `./ws-hub/index.ts`    — Public surface
 *
 * Existing callers (`import { WSHub } from "./ws-hub.js"`) continue to work.
 */

export * from "./ws-hub/index.js";