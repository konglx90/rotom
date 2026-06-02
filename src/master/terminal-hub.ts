/**
 * Web terminal hub — bridges browser xterm.js to a node-pty shell rooted in
 * the group's working directory.
 *
 * Wire protocol (JSON over WS):
 *   client → server  {type:"input",  data:string}
 *                    {type:"resize", cols:number, rows:number}
 *   server → client  {type:"output", data:string}
 *                    {type:"exit",   code:number|null, signal:number|null}
 *                    {type:"error",  message:string}
 *
 * Mounted on /api/terminal via httpServer 'upgrade' so it shares the master's
 * single port without touching the agent-protocol WSHub.
 *
 * node-pty is loaded lazily. If it isn't installed (optionalDependency), the
 * hub starts in a disabled state and rejects upgrades with 503 — keeping the
 * rest of the master functional.
 */

import { URL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { MeshDb } from "./db.js";
import { resolveGroupArtifactRoot } from "./group-paths.js";

interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface PtyHandle {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
}

interface PtyModule {
  spawn: (
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => PtyHandle;
}

const TERMINAL_PATH = "/api/terminal";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

async function loadPty(logger: Logger): Promise<PtyModule | null> {
  try {
    // Built as a runtime expression so tsc doesn't try to resolve the
    // optional `node-pty` package at build time. The module ships with
    // its own bundled .d.ts which we don't depend on (PtyModule above
    // captures the surface we actually use).
    const moduleName = "node-pty";
    const mod = (await import(moduleName)) as unknown as PtyModule & { default?: PtyModule };
    return mod.default ?? mod;
  } catch (err) {
    logger.warn(
      "[terminal] node-pty unavailable; web terminal disabled. " +
        "Run `pnpm install` (or `npm i node-pty`) to enable.",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export class TerminalHub {
  private wss: WebSocketServer | null = null;
  private pty: PtyModule | null = null;
  private upgradeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null;
  private delegatedUpgradeListeners: Array<(req: IncomingMessage, socket: Socket, head: Buffer) => void> = [];
  private sessions = new Set<string>();

  constructor(
    private httpServer: Server,
    private db: MeshDb,
    private logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.pty = await loadPty(this.logger);

    // WSHub constructs `WebSocketServer({ server, path: "/ws" })`, which adds
    // its own upgrade listener that aborts handshakes for any path other
    // than /ws. If we just `httpServer.on('upgrade', …)` alongside it, both
    // listeners fire — and WSHub's `abortHandshake` destroys our socket
    // milliseconds after we accept it. To avoid touching WSHub, we capture
    // the existing upgrade listeners, take over as the sole listener, and
    // delegate non-terminal paths back to them.
    this.delegatedUpgradeListeners = this.httpServer
      .listeners("upgrade")
      .slice() as Array<(req: IncomingMessage, socket: Socket, head: Buffer) => void>;
    this.httpServer.removeAllListeners("upgrade");

    if (!this.pty) {
      this.upgradeHandler = (req, socket, head) => {
        if (this.matchPath(req)) {
          this.rejectUpgrade(socket, 503, "node-pty not installed");
          return;
        }
        this.delegateUpgrade(req, socket, head);
      };
      this.httpServer.on("upgrade", this.upgradeHandler);
      return;
    }

    this.wss = new WebSocketServer({ noServer: true });
    this.upgradeHandler = (req, socket, head) => {
      if (!this.matchPath(req)) {
        this.delegateUpgrade(req, socket, head);
        return;
      }
      const parsed = this.parseTarget(req);
      if (!parsed) {
        this.rejectUpgrade(socket, 400, "missing groupId or cwd");
        return;
      }
      // Standalone (cwd) mode skips the group lookup entirely; groupId mode
      // still resolves through the db so it picks up the group's working_dir
      // override (or the default ~/.rotom/results/<groupId>).
      const cwd = parsed.kind === "cwd"
        ? parsed.cwd
        : resolveGroupArtifactRoot(this.db, parsed.groupId);
      const label = parsed.kind === "cwd" ? "standalone" : parsed.groupId;
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, label, cwd);
      });
    };
    this.httpServer.on("upgrade", this.upgradeHandler);
    this.logger.info(`[terminal] hub ready at ws path ${TERMINAL_PATH}`);
  }

  stop(): void {
    if (this.upgradeHandler) {
      this.httpServer.off("upgrade", this.upgradeHandler);
      this.upgradeHandler = null;
      // Restore the listeners we hijacked so other subsystems keep working
      // if the process keeps running after a TerminalHub-only stop.
      for (const fn of this.delegatedUpgradeListeners) {
        this.httpServer.on("upgrade", fn);
      }
      this.delegatedUpgradeListeners = [];
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private delegateUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.delegatedUpgradeListeners.length === 0) {
      // No other handler registered → match Node's default and 400 the
      // unsolicited upgrade rather than leaving the socket open.
      this.rejectUpgrade(socket, 400, "no upgrade handler");
      return;
    }
    for (const fn of this.delegatedUpgradeListeners) {
      try {
        fn.call(this.httpServer, req, socket, head);
      } catch (err) {
        this.logger.warn("[terminal] delegated upgrade listener threw:", err);
      }
    }
  }

  private matchPath(req: IncomingMessage): boolean {
    if (!req.url) return false;
    // url is /api/terminal?groupId=...; strip query
    const idx = req.url.indexOf("?");
    const pathname = idx >= 0 ? req.url.slice(0, idx) : req.url;
    return pathname === TERMINAL_PATH;
  }

  private parseTarget(
    req: IncomingMessage,
  ): { kind: "group"; groupId: string } | { kind: "cwd"; cwd: string } | null {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const cwdParam = url.searchParams.get("cwd");
      if (cwdParam) {
        // Accept any absolute path the master process can actually open.
        // The shell already has full local-user privileges, so this isn't
        // a privilege boundary — we just reject obviously-malformed input
        // so we don't hand node-pty something unusable.
        const trimmed = cwdParam.trim();
        if (!trimmed || trimmed.length > 1024) return null;
        if (!path.isAbsolute(trimmed)) return null;
        return { kind: "cwd", cwd: trimmed };
      }
      const id = url.searchParams.get("groupId");
      if (id && /^[A-Za-z0-9_-]+$/.test(id)) {
        return { kind: "group", groupId: id };
      }
      return null;
    } catch {
      return null;
    }
  }

  private rejectUpgrade(socket: Socket, status: number, reason: string): void {
    const text = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`;
    try {
      socket.write(text);
    } catch {
      /* ignore */
    }
    socket.destroy();
  }

  private handleConnection(ws: WebSocket, sessionLabel: string, cwd: string): void {
    if (!this.pty) {
      ws.close(1011, "pty unavailable");
      return;
    }
    const sessionId = `${sessionLabel}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.sessions.add(sessionId);

    // posix_spawnp from node-pty fails with a opaque "posix_spawnp failed"
    // when cwd doesn't exist. The group's working_dir or the default
    // ~/.rotom/results/<groupId> may have never been created. Make sure
    // we hand the pty a real, traversable directory.
    let spawnCwd = cwd;
    try {
      fs.mkdirSync(spawnCwd, { recursive: true });
    } catch (err) {
      this.logger.warn(`[terminal] cannot create cwd ${spawnCwd}, falling back to $HOME:`, err);
      spawnCwd = os.homedir();
    }
    if (!fs.existsSync(spawnCwd)) spawnCwd = os.homedir();

    const shell = process.env.SHELL || "/bin/bash";
    let term: PtyHandle;
    try {
      term = this.pty.spawn(shell, ["-l"], {
        name: "xterm-color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: spawnCwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[terminal] spawn failed for session=${sessionLabel} shell=${shell} cwd=${spawnCwd}: ${msg}`);
      try {
        ws.send(JSON.stringify({
          type: "error",
          message: `spawn failed (shell=${shell}, cwd=${spawnCwd}): ${msg}`,
        }));
      } catch { /* ignore */ }
      ws.close(1011, "spawn failed");
      this.sessions.delete(sessionId);
      return;
    }

    this.logger.info(`[terminal] session ${sessionId} pid=${term.pid} cwd=${spawnCwd}`);

    const dataSub = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "output", data }));
      } catch (err) {
        this.logger.warn(`[terminal] send failed for ${sessionId}:`, err);
      }
    });

    const exitSub = term.onExit(({ exitCode, signal }) => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null }));
        }
      } catch { /* ignore */ }
      try { ws.close(1000, "pty exit"); } catch { /* ignore */ }
    });

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; data?: string; cols?: number; rows?: number };
      if (m.type === "input" && typeof m.data === "string") {
        try { term.write(m.data); } catch (err) {
          this.logger.warn(`[terminal] write failed for ${sessionId}:`, err);
        }
      } else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") {
        const cols = Math.max(1, Math.min(500, Math.floor(m.cols)));
        const rows = Math.max(1, Math.min(200, Math.floor(m.rows)));
        try { term.resize(cols, rows); } catch (err) {
          this.logger.warn(`[terminal] resize failed for ${sessionId}:`, err);
        }
      }
    });

    const cleanup = () => {
      if (!this.sessions.has(sessionId)) return;
      this.sessions.delete(sessionId);
      try { dataSub.dispose(); } catch { /* ignore */ }
      try { exitSub.dispose(); } catch { /* ignore */ }
      try { term.kill(); } catch { /* ignore */ }
      this.logger.info(`[terminal] session ${sessionId} closed`);
    };

    ws.on("close", cleanup);
    ws.on("error", (err) => {
      this.logger.warn(`[terminal] ws error for ${sessionId}:`, err);
      cleanup();
    });
  }
}
