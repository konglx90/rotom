/**
 * Terminal hub — persistent PTY registry, multi-viewer fan-out, scrollback
 * replay, and idle-reap.
 *
 * Uses a fake node-pty (injected via the constructor's ptyOverride seam) so no
 * real shell is spawned. Drives the real http upgrade path + ws clients.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { TerminalHub } from "../src/master/terminal-hub.js";
import type { PtyHandle, PtyModule } from "../src/master/terminal-hub.js";

// Idle-reap is read from env at arm time, so setting it here is honored.
process.env.ROTOM_TERMINAL_IDLE_MS = "60";

interface FakeHandle extends PtyHandle {
  emit: (data: string) => void;
  isKilled: () => boolean;
}

let pidCounter = 1000;
function makeFakePty(): { module: PtyModule; handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const mod: PtyModule = {
    spawn: () => {
      const dataCbs = new Set<(d: string) => void>();
      const exitCbs = new Set<(e: { exitCode: number; signal?: number }) => void>();
      let killed = false;
      const handle: FakeHandle = {
        pid: ++pidCounter,
        write: () => {},
        resize: () => {},
        kill: () => {
          killed = true;
        },
        onData: (cb) => {
          dataCbs.add(cb);
          return { dispose: () => dataCbs.delete(cb) };
        },
        onExit: (cb) => {
          exitCbs.add(cb);
          return { dispose: () => exitCbs.delete(cb) };
        },
        emit: (d: string) => dataCbs.forEach((cb) => cb(d)),
        isKilled: () => killed,
      };
      handles.push(handle);
      return handle;
    },
  };
  return { module: mod, handles };
}

const TMP = os.tmpdir();
const noLogger = { info: () => {}, warn: () => {}, error: () => {} };

let server: http.Server;
let hub: TerminalHub;
let fake: ReturnType<typeof makeFakePty>;
let port = 0;

/** Connect and attach the output collector BEFORE open resolves, so replay
 *  frames sent at attach time aren't missed. */
function connect(query: string): Promise<{ ws: WebSocket; out: string[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?${query}`);
  const out: string[] = [];
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "output" && typeof m.data === "string") out.push(m.data);
    } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, out }));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(arr: string[], needle: string, timeoutMs = 800): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (arr.some((s) => s.includes(needle))) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for "${needle}" (got ${JSON.stringify(arr)})`);
}

function close(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on("close", () => resolve());
    ws.close();
  });
}

before(async () => {
  fake = makeFakePty();
  server = http.createServer();
  hub = new TerminalHub(server, {} as never, noLogger, fake.module);
  await hub.start();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  port = addr && typeof addr === "object" ? addr.port : 0;
});

after(async () => {
  hub.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TerminalHub persistent registry", () => {
  it("reattaches a second viewer to the same tid without spawning again", async () => {
    const baseline = fake.handles.length;
    const cwd = path.join(TMP, "rotom-term-reattach");
    const q = `cwd=${encodeURIComponent(cwd)}`;

    const c1 = await connect(q);
    assert.equal(fake.handles.length, baseline + 1, "first connection spawns one PTY");
    const handle = fake.handles[fake.handles.length - 1];

    // Produce output while c1 is attached → buffered for scrollback replay.
    handle.emit("hello-reattach\n");
    await waitFor(c1.out, "hello-reattach");

    const c2 = await connect(q);
    await waitFor(c2.out, "hello-reattach"); // replayed from buffer on reattach
    assert.equal(fake.handles.length, baseline + 1, "second connection reattaches, no new PTY");

    await close(c1.ws);
    await close(c2.ws);
  });

  it("fans out PTY output to all attached viewers", async () => {
    const baseline = fake.handles.length;
    const cwd = path.join(TMP, "rotom-term-broadcast");
    const q = `cwd=${encodeURIComponent(cwd)}`;

    const c1 = await connect(q);
    const c2 = await connect(q);
    assert.equal(fake.handles.length, baseline + 1, "same tid → one PTY");
    const handle = fake.handles[fake.handles.length - 1];

    handle.emit("broadcast-ping\n");
    await waitFor(c1.out, "broadcast-ping");
    await waitFor(c2.out, "broadcast-ping");

    await close(c1.ws);
    await close(c2.ws);
  });

  it("reaps the PTY after the last viewer detaches (idle)", async () => {
    const baseline = fake.handles.length;
    const cwd = path.join(TMP, "rotom-term-reap");
    const q = `cwd=${encodeURIComponent(cwd)}`;

    const c1 = await connect(q);
    assert.equal(fake.handles.length, baseline + 1);
    const handle = fake.handles[fake.handles.length - 1];

    await close(c1.ws);
    // ROTOM_TERMINAL_IDLE_MS=60 → killed shortly after the last viewer leaves.
    await sleep(240);
    assert.equal(handle.isKilled(), true, "PTY killed after idle window with no viewers");

    // A fresh connection spawns a brand-new PTY (registry entry was dropped).
    const c2 = await connect(q);
    assert.equal(fake.handles.length, baseline + 2, "new connection after reap spawns a new PTY");
    await close(c2.ws);
  });
});
