#!/usr/bin/env node
/**
 * Digital Employee Mesh — Master server (standalone entry point)
 *
 * Usage:
 *   node dist/master/server.js [--port 28800] [--host 0.0.0.0] [--data ~/.rotom]
 *
 * Or via package.json bin:
 *   mesh-master [--port 28800] [--data ~/.rotom]
 */

import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshDb } from "./db.js";
import { AuthService } from "./auth.js";
import { WSHub } from "./ws-hub.js";
import { Router } from "./router.js";
import { OfflineQueue } from "./offline-queue.js";
import { createApi } from "./api/index.js";
import { TerminalHub } from "./terminal-hub.js";
import { Scheduler } from "./scheduler.js";
import { ShareTokenStore } from "./share-tokens.js";
import { dispatchPatrolTerminal } from "./patrol-terminal.js";
import { DEFAULT_MASTER_PORT, DEFAULT_MASTER_HOST } from "../shared/constants.js";
import os from "node:os";
import { createLogger, enableFileLogging, closeFileLogging } from "../shared/logger.js";
import { getMasterIdentity } from "./federation/identity.js";
import { runOpcBootstrap, ensureLocalExecutor, type LocalExecutor } from "./opc-bootstrap.js";
import { initFederationManager } from "./federation/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger("mesh-master");

// ---------------------------------------------------------------------------
// Config from CLI args
// ---------------------------------------------------------------------------

interface MasterConfig {
  port: number;
  host: string;
  dataDir: string;
}

function resolveDataDir(): string {
  return process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
}

function parseArgs(): MasterConfig {
  const args = process.argv.slice(2);
  const config: MasterConfig = {
    port: DEFAULT_MASTER_PORT,
    host: DEFAULT_MASTER_HOST,
    dataDir: resolveDataDir(),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
      case "-p":
        config.port = parseInt(args[++i]) || DEFAULT_MASTER_PORT;
        break;
      case "--host":
      case "-h":
        config.host = args[++i] || DEFAULT_MASTER_HOST;
        break;
      case "--data":
      case "-d":
        config.dataDir = args[++i] || resolveDataDir();
        break;
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();

  // Enable daily-rotated file logging under data directory
  enableFileLogging(path.join(path.resolve(config.dataDir), "logs"));

  log.info("Starting...");
  log.info(`Data directory: ${path.resolve(config.dataDir)}`);

  // Database
  const db = new MeshDb(path.join(config.dataDir, "mesh.db"));

  // Skill 文件 ↔ DB 双向收敛(文件 = 真相源)。boot 时跑一次:文件→DB upsert、
  // DB active 行无文件则 backfill。失败不阻断启动。
  try {
    const r = db.reconcileSkills();
    if (r.added || r.updated || r.backfilled) {
      log.info(`Skill reconcile: +${r.added} added, ~${r.updated} updated, ↻${r.backfilled} backfilled`);
    }
  } catch (e) {
    log.warn(`Skill reconcile failed (non-fatal): ${(e as Error).message}`);
  }

  // OPC bootstrap — 解析本机 master 身份 + 首次启动建默认 agent / group。
  // 失败(hostname 校验等)直接终止启动 —— OPC 是底层身份,不能没有。
  const identity = getMasterIdentity({ rotomHome: config.dataDir });
  const opcResult = runOpcBootstrap(db, identity);

  // Patrol auto-sync: when an issue reaches terminal state, advance patrol state.
  // 统一走 dispatchPatrolTerminal —— 它按 issueId 反查 link_patrol_runs 决定走
  // link 分类流程还是 issue 巡检流程(见 patrol-terminal.ts)。
  db._onIssueTerminal = (issueId: string) => {
    const issue = db.getIssueById(issueId);
    if (!issue) return;
    const group = db.getGroupByIdFull(issue.group_id);
    if (group?.type === "patrol" || group?.type === "patrol-link") {
      dispatchPatrolTerminal(db, issue);
    }
  };

  // Reset stale online status from previous run
  const resetCount = db.resetAllOnline();
  if (resetCount > 0) {
    log.info(`Reset ${resetCount} stale online agent(s) to offline`);
  }

  // Services — single AuthService shared between WSHub and API
  const auth = new AuthService(db);
  const offlineQueue = new OfflineQueue(db);
  const router = new Router(db, log);
  const shareTokens = new ShareTokenStore();

  // HTTP + Express
  const app = express();
  // 15mb to allow base64-encoded image uploads via /api/uploads (see
  // uploads.ts MAX_UPLOAD_BYTES — kept in sync). Regular JSON endpoints
  // don't approach this; the limit is a ceiling, not a default allocation.
  app.use(express.json({ limit: "15mb" }));

  // Dashboard (static files)
  // Prod (running from dist/master): build:master copies React dashboard
  // build output to dist/master/dashboard.
  // Dev (running src/master via tsx): fall back to packages/dashboard build
  // output — run `pnpm dashboard:build` first.
  let dashboardDir = path.resolve(__dirname, "dashboard");
  if (!fs.existsSync(dashboardDir)) {
    dashboardDir = path.resolve(__dirname, "../../packages/dashboard/dist/src/master/dashboard");
  }
  if (!fs.existsSync(dashboardDir)) {
    log.warn(`Dashboard files not found. Run \`pnpm dashboard:build\` then retry. Looked in: ${dashboardDir}`);
  } else {
    log.info(`Dashboard files: ${dashboardDir}`);
  }
  app.use("/dashboard", express.static(dashboardDir));
  // SPA fallback — serve index.html for all /dashboard/* routes (client-side routing)
  app.get("/dashboard/*", (_req, res) => {
    res.sendFile(path.join(dashboardDir, "index.html"));
  });

  // Root redirect
  app.get("/", (_req, res) => res.redirect("/dashboard"));

  // Health check (unauthenticated)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ...db.stats() });
  });

  // Create HTTP server first — needed by WSHub
  const httpServer = http.createServer(app);

  // WebSocket Hub (attaches to HTTP server) — shares auth service
  const hub = new WSHub(httpServer, db, auth, router, offlineQueue, log);
  hub.start();

  // Federation:FederationManager 封装 fedClient/fedPublisher/fedServer 生命周期。
  // API 层(POST /api/teams/join)可通过 getFederationManager() runtime 切换 federation 状态。
  const federationManager = initFederationManager({
    db, hub, router, httpServer, identity,
    rotomHome: config.dataDir,
    masterPort: config.port,
  });
  federationManager.initFromRole();

  // Web terminal hub — mounts on /api/terminal alongside the agent /ws.
  // Lazy-loads node-pty; no-op if the optional dep isn't installed.
  const terminalHub = new TerminalHub(httpServer, db, log);
  await terminalHub.start();

  // Scheduled-task scheduler — 30s tick interval, drives scheduled_tasks rows
  // that trigger pushIssueAssignment (agent mode) or postSystemToGroup (message mode).
  const scheduler = new Scheduler(db, hub);
  scheduler.start();

  // Ensure a2a-direct TTL sweep recurring task — 挂到 OPC bootstrap 创建的 defaultGroup。
  // 每 1 小时跑一次,扫 last_activity_at 早于 3 天的未归档 a2a_direct pair 群,archive。
  // 重复启动不重复建(按 handler_key 查重)。
  if (opcResult.defaultGroup) {
    const existing = db.findScheduledTaskByHandlerKey("a2a-direct-ttl-sweep");
    if (!existing) {
      db.createScheduledTask({
        name: "a2a-direct TTL sweep",
        groupId: opcResult.defaultGroup.id,
        mode: "message",
        scheduleKind: "interval",
        intervalSec: 3600,
        prompt: "TTL sweep: archive a2a_direct pair groups inactive for 3 days",
        handlerKey: "a2a-direct-ttl-sweep",
        handlerPayload: "{}",
        repeatTimes: null,
      });
      log.info(`Registered a2a-direct TTL sweep task on group ${opcResult.defaultGroup.id} (every 1h)`);
    }
  }

  // REST API — shares auth service and hub with WSHub
  app.use("/api", createApi(db, auth, hub, router, config.port, shareTokens));

  // Listen
  let localExecutor: LocalExecutor | null = null;
  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => {
      log.info(`Running on http://${config.host}:${config.port}`);
      log.info(`Dashboard: http://localhost:${config.port}/dashboard`);
      log.info(`WebSocket: ws://localhost:${config.port}/ws`);
      log.info(`Terminal:  ws://localhost:${config.port}/api/terminal`);
      log.info(`API: http://localhost:${config.port}/api`);
      log.warn("API authentication is DISABLED (internal network mode)");
      // master 监听 ready 后再 spawn 本机 executor —— 避免 executor 比 master 早起来连不上。
      // 注意:即使用户已有 agents(OPC bootstrap 没建 defaultAgent),也要 spawn executor,
      // 否则用户的 agents 上不了线。defaultAgentName 仅用于 .auto-executor.json 的兜底,
      // scanClis 模式下用不到。
      localExecutor = ensureLocalExecutor({
        rotomHome: config.dataDir,
        masterPort: config.port,
        defaultAgentName: opcResult.defaultAgent?.name,
      });
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    federationManager.stop();
    localExecutor?.stop();
    scheduler.stop();
    hub.stop();
    terminalHub.stop();
    router.stop();
    db.close();
    httpServer.close(() => {
      log.info("Goodbye.");
      closeFileLogging();
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
