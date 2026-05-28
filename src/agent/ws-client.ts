/**
 * Digital Employee Mesh — Agent WebSocket Client
 *
 * Single WebSocket connection to Master. Handles:
 * - Connect to a Master URL
 * - Send/receive JSON messages
 * - Emit events for connection lifecycle
 *
 * Does NOT handle reconnect — that's SocketManager's job.
 */

import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

export type WSClientEvents = {
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (err: Error) => void;
  message: (msg: ServerMessage) => void;
};

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers: Partial<WSClientEvents> = {};

  constructor(private url: string) {}

  on<K extends keyof WSClientEvents>(event: K, handler: WSClientEvents[K]): void {
    this.handlers[event] = handler;
  }

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.handlers.open?.();
    });

    this.ws.on("close", (code, reason) => {
      this.handlers.close?.(code, reason.toString());
    });

    this.ws.on("error", (err) => {
      this.handlers.error?.(err);
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        this.handlers.message?.(msg);
      } catch {
        // Ignore unparseable messages from server
      }
    });
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "Client closing");
      }
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
