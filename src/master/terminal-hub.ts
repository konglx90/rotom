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
 * ## Persistent PTY registry (group switch ≠ disconnect)
 * The PTY's lifetime is decoupled from any single WebSocket. Each terminal is
 * keyed by a stable `tid` (`group:<groupId>` or `cwd:<path>`). Closing a WS
 * only detaches that viewer; the PTY keeps running (so `npm run dev` survives
 * group switches, panel collapse, route changes). A second WS for the same tid
 * reattaches — its scrollback is replayed from a ring buffer. When the last
 * viewer leaves, an idle-reap timer arms; if nobody reattaches within
 * ROTOM_TERMINAL_IDLE_MS (default 30 min) the PTY is killed and dropped.
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
import { decodeJson } from "../shared/json-codec.js";

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

interface TerminalSession {
  tid: string;
  pty: PtyHandle;
  cwd: string;
  /** Live WS viewers — output is fanned out to all, input accepted from any. */
  viewers: Set<WebSocket>;
  /** Scrollback ring buffer (PTY output chunks) replayed on reattach. */
  buffer: string[];
  bufferBytes: number;
  idleTimer: NodeJS.Timeout | null;
  dataSub: { dispose: () => void };
  exitSub: { dispose: () => void };
}

const TERMINAL_PATH = "/api/terminal";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Scrollback cap per terminal — ≈ a few thousand lines, matching xterm's 5000. */
const MAX_BUFFER_BYTES = 256 * 1024;

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
  /** tid → live PTY session. Survives WS disconnects until idle-reap/exit. */
  private registry = new Map<string, TerminalSession>();

  constructor(
    private httpServer: Server,
    private db: MeshDb,
    private logger: Logger,
    /** Test seam: inject a fake pty module to avoid spawning real shells. */
    private ptyOverride?: PtyModule,
  ) {}

  async start(): Promise<void> {
    this.pty = this.ptyOverride ?? await loadPty(this.logger);

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
      // override (or the default ~/.rotom/artifacts/<groupId>).
      const tid = parsed.kind === "cwd" ? `cwd:${parsed.cwd}` : `group:${parsed.groupId}`;
      const cwd = parsed.kind === "cwd" ? parsed.cwd : resolveGroupArtifactRoot(this.db, parsed.groupId);
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, tid, cwd);
      });
    };
    this.httpServer.on("upgrade", this.upgradeHandler);
    const ms = this.getIdleReapMs();
    const idleDesc = ms === Infinity ? "off" : `${ms}ms`;
    this.logger.info(`[terminal] hub ready at ws path ${TERMINAL_PATH} (idle-reap=${idleDesc})`);
  }

  /** Idle-reap delay after the last viewer detaches. <=0 disables reaping. */
  private getIdleReapMs(): number {
    const raw = Number(process.env.ROTOM_TERMINAL_IDLE_MS);
    if (!Number.isFinite(raw)) return 30 * 60 * 1000;
    return raw <= 0 ? Infinity : raw;
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
    // Kill every lingering PTY so we don't leak shells across a master stop.
    for (const session of this.registry.values()) {
      this.destroySession(session, "hub stop");
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

  private handleConnection(ws: WebSocket, tid: string, cwd: string): void {
    if (!this.pty) {
      ws.close(1011, "pty unavailable");
      return;
    }
    const existing = this.registry.get(tid);
    if (existing) {
      this.attachViewer(existing, ws);
      return;
    }
    this.createSession(tid, cwd, ws);
  }

  /** Spawn a fresh PTY for `tid`, register it, then attach the opening viewer. */
  private createSession(tid: string, cwd: string, ws: WebSocket): void {
    if (!this.pty) {
      ws.close(1011, "pty unavailable");
      return;
    }

    // posix_spawnp from node-pty fails with a opaque "posix_spawnp failed"
    // when cwd doesn't exist. The group's working_dir or the default
    // ~/.rotom/artifacts/<groupId> may have never been created. Make sure
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
    let pty: PtyHandle;
    try {
      pty = this.pty.spawn(shell, ["-l"], {
        name: "xterm-color",
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: spawnCwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[terminal] spawn failed for tid=${tid} shell=${shell} cwd=${spawnCwd}: ${msg}`);
      try {
        ws.send(JSON.stringify({
          type: "error",
          message: `spawn failed (shell=${shell}, cwd=${spawnCwd}): ${msg}`,
        }));
      } catch { /* ignore */ }
      ws.close(1011, "spawn failed");
      return;
    }

    this.logger.info(`[terminal] session ${tid} pid=${pty.pid} cwd=${spawnCwd}`);

    const session: TerminalSession = {
      tid,
      pty,
      cwd: spawnCwd,
      viewers: new Set(),
      buffer: [],
      bufferBytes: 0,
      idleTimer: null,
      dataSub: { dispose: () => {} },
      exitSub: { dispose: () => {} },
    };

    session.dataSub = pty.onData((data) => {
      this.appendToBuffer(session, data);
      this.broadcast(session, { type: "output", data });
    });

    session.exitSub = pty.onExit(({ exitCode, signal }) => {
      this.broadcast(session, { type: "exit", code: exitCode, signal: signal ?? null });
      this.destroySession(session, "pty exit");
    });

    this.registry.set(tid, session);
    this.attachViewer(session, ws);
  }

  /** Link an opening WS to a live session: replay scrollback, pipe I/O. */
  private attachViewer(session: TerminalSession, ws: WebSocket): void {
    // Cancel any pending idle-reap — somebody is watching again.
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.viewers.add(ws);

    // Replay scrollback to THIS viewer only (others already have it).
    // Sent as regular output chunks; the client clears its term on open so
    // the replay fills a clean buffer.
    for (const chunk of session.buffer) {
      if (ws.readyState !== WebSocket.OPEN) break;
      try {
        ws.send(JSON.stringify({ type: "output", data: chunk }));
      } catch (err) {
        this.logger.warn(`[terminal] replay send failed for ${session.tid}:`, err);
        break;
      }
    }

    ws.on("message", (raw) => {
      const m = decodeJson<{ type?: string; data?: string; cols?: number; rows?: number }>(raw);
      if (!m || typeof m !== "object") return;
      // The session may have been destroyed (pty exited) between attach and
      // this message; guard before touching the pty.
      if (!this.registry.has(session.tid)) return;
      if (m.type === "input" && typeof m.data === "string") {
        try { session.pty.write(m.data); } catch (err) {
          this.logger.warn(`[terminal] write failed for ${session.tid}:`, err);
        }
      } else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") {
        const cols = Math.max(1, Math.min(500, Math.floor(m.cols)));
        const rows = Math.max(1, Math.min(200, Math.floor(m.rows)));
        try { session.pty.resize(cols, rows); } catch (err) {
          this.logger.warn(`[terminal] resize failed for ${session.tid}:`, err);
        }
      }
    });

    const detach = () => this.detachViewer(session, ws);
    ws.on("close", detach);
    ws.on("error", (err) => {
      this.logger.warn(`[terminal] ws error for ${session.tid}:`, err);
      detach();
    });
  }

  /** Remove one viewer; if none remain, arm the idle-reap timer. */
  private detachViewer(session: TerminalSession, ws: WebSocket): void {
    session.viewers.delete(ws);
    const ms = this.getIdleReapMs();
    if (session.viewers.size === 0 && ms !== Infinity) {
      session.idleTimer = setTimeout(() => {
        this.destroySession(session, "idle-reap");
      }, ms);
      this.logger.info(`[terminal] session ${session.tid} idle (last viewer left); reap in ${ms}ms`);
    }
  }

  /** Tear down a session for real: kill PTY, drop registry entry, close viewers. */
  private destroySession(session: TerminalSession, reason: string): void {
    if (!this.registry.has(session.tid)) return;
    this.registry.delete(session.tid);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    try { session.dataSub.dispose(); } catch { /* ignore */ }
    try { session.exitSub.dispose(); } catch { /* ignore */ }
    try { session.pty.kill(); } catch { /* ignore */ }
    for (const ws of session.viewers) {
      try { ws.close(1000, reason); } catch { /* ignore */ }
    }
    session.viewers.clear();
    this.logger.info(`[terminal] session ${session.tid} destroyed (${reason})`);
  }

  private appendToBuffer(session: TerminalSession, data: string): void {
    session.buffer.push(data);
    session.bufferBytes += Buffer.byteLength(data);
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
      const dropped = session.buffer.shift()!;
      session.bufferBytes -= Buffer.byteLength(dropped);
    }
  }

  private broadcast(session: TerminalSession, msg: { type: string; [k: string]: unknown }): void {
    const json = JSON.stringify(msg);
    for (const ws of session.viewers) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(json);
      } catch (err) {
        this.logger.warn(`[terminal] broadcast send failed for ${session.tid}:`, err);
      }
    }
  }
}
