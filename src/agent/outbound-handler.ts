/**
 * Digital Employee Mesh — Outbound Handler
 *
 * Takes a reply string and sends it back to Master as a2a_reply.
 * Supports streaming via a2a_reply_chunk / a2a_reply_end.
 */

import type { SocketManager } from "./socket-manager.js";

export class OutboundHandler {
  constructor(private socket: SocketManager) {}

  /** Send a complete reply for a given requestId back through Master. */
  reply(requestId: string, message: string): boolean {
    return this.socket.send({
      type: "a2a_reply",
      requestId,
      payload: { message },
    });
  }

  /** Send a streaming chunk for a given requestId. */
  replyChunk(requestId: string, delta: string): boolean {
    return this.socket.send({
      type: "a2a_reply_chunk",
      requestId,
      delta,
    });
  }

  /** Signal that streaming is complete for a given requestId. */
  replyEnd(requestId: string, message: string): boolean {
    return this.socket.send({
      type: "a2a_reply_end",
      requestId,
      payload: { message },
    });
  }
}
