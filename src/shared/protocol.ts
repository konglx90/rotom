/**
 * Digital Employee Mesh — Protocol definitions
 *
 * All WebSocket message types between Agent and Master.
 *
 * This file is a barrel re-exporting from `./protocol/` submodules so
 * existing `import { ... } from "../shared/protocol.js"` call sites keep
 * working. New code may import from the specific sub-path:
 *   - "../shared/protocol/enums.js"           — REAL_PERSONS, RealPerson
 *   - "../shared/protocol/types.js"           — base value interfaces
 *   - "../shared/protocol/client-messages.js" — ClientMessage union + shapes
 *   - "../shared/protocol/server-messages.js" — ServerMessage union + shapes
 *   - "../shared/protocol/guards.js"          — isClientMessage / isServerMessage
 */

export * from "./protocol/enums.js";
export * from "./protocol/types.js";
export * from "./protocol/client-messages.js";
export * from "./protocol/server-messages.js";
export { isClientMessage, isServerMessage } from "./protocol/guards.js";
