/**
 * WorkerConnection — WS lifecycle for ExecutorWorker.
 *
 * Owns heartbeat + reconnect timers. The underlying `ws` socket lives on the
 * worker (shared with send helpers), this module just wires connect/reconnect
 * and routes incoming messages back to `worker.handleMessage`.
 */
import { WebSocket } from "ws";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { decodeJson } from "../shared/json-codec.js";
import type { ExecutorWorker } from "./worker.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-executor-worker-connection", { stream: "stderr" });

export class WorkerConnection {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly worker: ExecutorWorker) {}

  start(): void {
    this.worker.stopped = false;
    this.connect();
  }

  stop(): void {
    this.worker.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.worker.ws) this.worker.ws.close(1000, "shutdown");
  }

  /** Called from handleMessage on auth_ok. Starts the 10s heartbeat loop. */
  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.worker.ws?.readyState === WebSocket.OPEN) {
        this.worker.ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 10_000);
  }

  private wsUrl(): string {
    let url = this.worker.masterUrl;
    if (!url.endsWith("/ws")) url += "/ws";
    return url;
  }

  private connect(): void {
    if (this.worker.stopped) return;
    const url = this.wsUrl();
    const cliName = this.worker.config.cliTool || "auto";
    log.info(this.worker.tag, "Connecting to", url, `(cli: ${cliName}, cwd: ${this.worker.workingDir})`);

    this.worker.ws = new WebSocket(url);

    this.worker.ws.on("open", () => {
      this.worker.ws.send(JSON.stringify({
        type: "auth",
        name: this.worker.config.name,
        token: this.worker.config.token,
        version: 2,
        profile: this.worker.config.profile || {},
        cliTool: this.worker.cliTool,
        instance: {
          instanceId: `${os.hostname()}-${process.pid}-${randomUUID()}`,
          hostname: os.hostname(),
          platform: `${process.platform} ${process.arch}`,
          endpoint: this.worker.masterUrl,
        },
      }));
    });

    this.worker.ws.on("message", (raw) => {
      const msg = decodeJson<Record<string, unknown>>(raw);
      if (!msg) return;
      this.worker.handleMessage(msg);
    });

    this.worker.ws.on("close", () => {
      log.info(this.worker.tag, "Disconnected, reconnecting in 3s...");
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (!this.worker.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3_000);
      }
    });

    this.worker.ws.on("error", (err) => {
      log.error(this.worker.tag, "WS error:", err.message);
    });
  }
}
