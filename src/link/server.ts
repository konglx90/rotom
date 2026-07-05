/**
 * rotom-link daemon —— 轻量 federation 客户端节点。
 *
 * 角色定位:不带本机 agent 的 member。复用 FedClient 连协调 master,
 * 接收 FedDirectorySync 缓存可见 agent,通过 FedRouteMessage 跨机投递
 * 消息给其他 member 上的 agent(或协调 master 自身的 agent),等 FedReply。
 *
 * 对外暴露 localhost HTTP:
 *   GET  /health          → { ok, masterId, teamId, hostname, coordEndpoint, connected, pending }
 *   GET  /fed/directory   → 可见 agent 列表
 *   POST /fed/ask         → { to: "name@hostname", message, from?: "name" } 阻塞等 reply
 *
 * 配置文件 ~/.rotom/link.json: { masterId, hostname, coordEndpoint, teamId }
 * 由 `rotom link join <coordEndpoint>` 一次性生成。
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { FedClient } from "../master/federation/client.js";
import { generateMasterId } from "../master/federation/identity.js";
import { InMemoryVisibilityStore } from "./visibility-store.js";
import { PendingRequests } from "./pending-requests.js";
import { parseAgentRef, formatAgentRef, type FedAgentRef } from "../shared/protocol/federation.js";
import type { MasterIdentity } from "../master/federation/identity.js";
import type { MeshDb } from "../master/db.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("rotom-link", { stream: "stderr" });

const DEFAULT_PORT = 28900;
const LINK_CONFIG_FILE = "link.json";

export interface LinkConfig {
  masterId: string;
  hostname: string;
  coordEndpoint: string;
  teamId: string;
  teamName?: string;
}

function rotomHome(): string {
  return process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
}

function linkConfigPath(): string {
  return path.join(rotomHome(), LINK_CONFIG_FILE);
}

export function readLinkConfig(): LinkConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(linkConfigPath(), "utf-8"));
    if (raw?.masterId && raw?.coordEndpoint && raw?.teamId) {
      return raw as LinkConfig;
    }
  } catch { /* not joined yet */ }
  return null;
}

function writeLinkConfig(cfg: LinkConfig): void {
  fs.mkdirSync(rotomHome(), { recursive: true });
  fs.writeFileSync(linkConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

/** CLI 调:rotom link join <coordEndpoint> --hostname <name> */
export async function linkJoin(coordEndpoint: string, hostname: string): Promise<void> {
  // 1. probe coord /api/identity 拿 teamId(coord 的 masterId)
  const httpUrl = coordEndpoint
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/$/, "");
  const res = await fetch(`${httpUrl}/api/identity`);
  if (!res.ok) {
    throw new Error(`Failed to fetch coord identity: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { id: string; role: string; hostname: string; teamName?: string };
  if (data.role !== "coordination") {
    throw new Error(`Target master is not a coordination master (role=${data.role})`);
  }
  // 2. 生成 masterId(本地持久化)
  const existing = readLinkConfig();
  const masterId = existing?.masterId ?? generateMasterId();
  const cfg: LinkConfig = {
    masterId,
    hostname,
    coordEndpoint,
    teamId: data.id,
    teamName: data.teamName ?? `${data.hostname} 团队`,
  };
  writeLinkConfig(cfg);
  log.info(`[rotom-link] joined team ${cfg.teamId} as ${cfg.masterId}/${cfg.hostname}`);
}

interface LinkServerOpts {
  port: number;
  config: LinkConfig;
}

export async function startLinkServer(opts: LinkServerOpts): Promise<void> {
  const { port, config } = opts;

  // 1. 构造 in-memory db + FedClient
  const store = new InMemoryVisibilityStore();
  const identity: MasterIdentity = {
    id: config.masterId,
    hostname: config.hostname,
    role: "member",
    teamName: config.teamName ?? "",
  };
  const fedClient = new FedClient(store as unknown as MeshDb, {
    identity,
    coordEndpoints: [config.coordEndpoint],
    teamId: config.teamId,
    role: "member",
  });
  const pending = new PendingRequests();
  fedClient.setHandlers({
    deliverLocal: () => false, // link 无本机 agent
    handleReply: (msg) => {
      pending.resolve(msg.requestId, msg.payload.message);
    },
    handleRouteFailed: (msg) => {
      pending.reject(msg.requestId, new Error(`route failed: ${msg.reason}`));
    },
  });
  fedClient.start();

  // 2. HTTP server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && pathname === "/health") {
      res.end(JSON.stringify({
        ok: true,
        masterId: config.masterId,
        hostname: config.hostname,
        teamId: config.teamId,
        coordEndpoint: config.coordEndpoint,
        connected: fedClient.isConnected(),
        pending: pending.size(),
      }));
      return;
    }

    if (req.method === "GET" && pathname === "/fed/directory") {
      res.end(JSON.stringify({ ok: true, agents: store.listForHttp(config.teamId) }));
      return;
    }

    if (req.method === "POST" && pathname === "/fed/ask") {
      try {
        const body = await readBody(req);
        const { to, message, from, mode, timeoutMs, escalateTo } = body as {
          to: string; message: string; from?: string;
          mode?: "sync" | "async"; timeoutMs?: number; escalateTo?: string | null;
        };
        if (!to || !message) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "to and message are required" }));
          return;
        }
        if (!fedClient.isConnected()) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: "fed client not connected to coord" }));
          return;
        }
        const { name: toName, hostname: toHostname } = parseAgentRef(to);
        if (!toHostname) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: `to must be "name@hostname" (got "${to}")` }));
          return;
        }
        const toRef: FedAgentRef = { hostname: toHostname, name: toName };
        // from 用本地 hostname + 指定 name(默认 "link-user")
        const fromName = from ?? "link-user";
        const fromRef: FedAgentRef = { hostname: config.hostname, name: fromName };
        const requestId = crypto.randomUUID();
        const { promise } = pending.register(requestId);
        // `rotom ask` 联邦路径:携带 bridge 字段让协调 master 建群+bridge
        const bridgeMode: "sync" | "async" = mode === "async" ? "async" : "sync";
        const bridgeTimeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 5 * 60_000;
        const ok = fedClient.route(
          requestId,
          fromRef,
          toRef,
          { message },
          undefined,
          {
            mode: bridgeMode,
            asker: fromName,
            target: toName,
            timeoutMs: bridgeTimeout,
            escalateTo: escalateTo ?? null,
          },
        );
        if (!ok) {
          pending.reject(requestId, new Error("fed route failed (client not connected)"));
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: "fed route failed" }));
          return;
        }
        const reply = await promise;
        res.end(JSON.stringify({ ok: true, reply, requestId }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: `not found: ${req.method} ${pathname}` }));
  });

  // 3. 启动 + 优雅关闭
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  log.info(`[rotom-link] listening on http://127.0.0.1:${port} (teamId=${config.teamId})`);

  const shutdown = (signal: string) => {
    log.info(`[rotom-link] received ${signal}, shutting down...`);
    pending.rejectAll(new Error("link daemon shutting down"));
    fedClient.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (chunk) => { buf += chunk; });
    req.on("end", () => {
      if (!buf) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${(e as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

// ── CLI entry: `node dist/link/server.js --port N` ────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  const config = readLinkConfig();
  if (!config) {
    process.stderr.write(
      `[rotom-link] no ${linkConfigPath()} found. Run ` +
      `\`rotom link join <coordEndpoint> --hostname <name>\` first.\n`,
    );
    process.exit(1);
  }
  await startLinkServer({ port, config });
}

// re-exports for CLI
export { formatAgentRef };

// run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[rotom-link] fatal: ${e.message}\n`);
    process.exit(1);
  });
}
