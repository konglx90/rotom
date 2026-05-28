#!/usr/bin/env node
/**
 * Digital Employee Mesh — Master server (standalone entry point)
 *
 * Usage:
 *   node dist/master/server.js [--port 18800] [--host 0.0.0.0] [--data ./mesh-data]
 *
 * Or via package.json bin:
 *   mesh-master [--port 18800] [--data ./mesh-data]
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
import { createApi, sha256 } from "./api.js";
import { DEFAULT_MASTER_PORT, DEFAULT_MASTER_HOST } from "../shared/constants.js";
import { createLogger, enableFileLogging, closeFileLogging } from "../shared/logger.js";

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

function parseArgs(): MasterConfig {
  const args = process.argv.slice(2);
  const config: MasterConfig = {
    port: DEFAULT_MASTER_PORT,
    host: DEFAULT_MASTER_HOST,
    dataDir: "./mesh-data",
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
        config.dataDir = args[++i] || "./mesh-data";
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

  // Reset stale online status from previous run
  const resetCount = db.resetAllOnline();
  if (resetCount > 0) {
    log.info(`Reset ${resetCount} stale online agent(s) to offline`);
  }

  // Initialize dashboard credentials (env vars override DB on every startup)
  const envUser = process.env.MESH_DASHBOARD_USER;
  const envPass = process.env.MESH_DASHBOARD_PASS;
  if (envUser || envPass) {
    db.setConfig("dashboard_user", envUser || "admin");
    db.setConfig("dashboard_pass_hash", sha256(envPass || "admin123"));
    log.info(`Dashboard credentials set from environment variables (user=${envUser || "admin"})`);
  } else if (!db.getConfig("dashboard_user")) {
    db.setConfig("dashboard_user", "admin");
    db.setConfig("dashboard_pass_hash", sha256("admin123"));
    log.info("Default dashboard credentials created (admin/admin123)");
  }

  // Services — single AuthService shared between WSHub and API
  const auth = new AuthService(db);
  const offlineQueue = new OfflineQueue(db);
  const router = new Router(db, log);

  // HTTP + Express
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Dashboard (static files — try dist/src/master, then dist/master, then source)
  let dashboardDir = path.resolve(__dirname, "../src/master/dashboard");
  if (!fs.existsSync(dashboardDir)) {
    dashboardDir = path.resolve(__dirname, "dashboard");
  }
  if (!fs.existsSync(dashboardDir)) {
    dashboardDir = path.resolve(__dirname, "../../../src/master/dashboard");
  }
  log.info(`Dashboard files: ${dashboardDir}`);
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

  // REST API — shares auth service and hub with WSHub
  app.use("/api", createApi(db, auth, hub, router, config.port));

  // Listen
  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => {
      log.info(`Running on http://${config.host}:${config.port}`);
      log.info(`Dashboard: http://localhost:${config.port}/dashboard`);
      log.info(`WebSocket: ws://localhost:${config.port}/ws`);
      log.info(`API: http://localhost:${config.port}/api`);
      log.warn("API authentication is DISABLED (internal network mode)");
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    hub.stop();
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
