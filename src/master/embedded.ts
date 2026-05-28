/**
 * Digital Employee Mesh — Embedded Master
 *
 * Starts Master HTTP+WS server programmatically (non-standalone).
 * Used by startEmbeddedMaster() for in-process Master startup.
 *
 * Unlike server.ts (standalone entry), this does NOT call process.exit()
 * or listen for SIGINT/SIGTERM — the host process manages lifecycle.
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
import { createApi } from "./api.js";
import { createLogger, enableFileLogging, closeFileLogging } from "../shared/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddedMasterConfig {
  port: number;
  host?: string;
  dataDir: string;
}

export interface EmbeddedMasterHandle {
  /** Stop the embedded master (close HTTP server, DB, etc.) */
  stop(): Promise<void>;
  /** The port the master is listening on */
  port: number;
  /** The MeshDb instance (for registration helpers) */
  db: MeshDb;
  /** The WSHub instance (for pushing config updates) */
  hub: WSHub;
  /** The API key for authenticated API calls */
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startEmbeddedMaster(
  config: EmbeddedMasterConfig,
  logger: Pick<Console, "log" | "info" | "warn" | "error"> = createLogger("mesh-master"),
): Promise<EmbeddedMasterHandle> {
  const host = config.host ?? "0.0.0.0";

  // Ensure data directory exists
  const dataDir = path.resolve(config.dataDir);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Enable daily-rotated file logging under data directory
  enableFileLogging(path.join(dataDir, "logs"));

  // Database
  const db = new MeshDb(path.join(dataDir, "mesh.db"));

  // Reset stale online status from previous run
  const resetCount = db.resetAllOnline();
  if (resetCount > 0) {
    logger.info(`[mesh-master] Reset ${resetCount} stale online agent(s) to offline`);
  }

  // Services — single AuthService shared between WSHub and API
  const auth = new AuthService(db);
  const offlineQueue = new OfflineQueue(db);
  const router = new Router(db, logger);

  // HTTP + Express
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Create HTTP server first — needed by WSHub
  const httpServer = http.createServer(app);

  // WebSocket Hub — shares auth service with API
  const hub = new WSHub(httpServer, db, auth, router, offlineQueue, logger);
  hub.start();

  // REST API — shares auth service and hub with WSHub
  app.use("/api", createApi(db, auth, hub, router, config.port));

  // Dashboard static files
  // Prod (running from dist/master): build:master copies React dashboard
  // build output to dist/master/dashboard.
  // Dev (running src/master via tsx): fall back to packages/dashboard build
  // output — run `pnpm dashboard:build` first.
  let dashboardDir = path.resolve(__dirname, "dashboard");
  if (!fs.existsSync(dashboardDir)) {
    dashboardDir = path.resolve(__dirname, "../../packages/dashboard/dist/src/master/dashboard");
  }
  if (fs.existsSync(dashboardDir)) {
    app.use("/dashboard", express.static(dashboardDir));
    // SPA fallback — serve index.html for all /dashboard/* routes (client-side routing)
    app.get("/dashboard/*", (_req, res) => {
      res.sendFile(path.join(dashboardDir, "index.html"));
    });
  }

  // Root redirect
  app.get("/", (_req, res) => res.redirect("/dashboard"));

  // Health check (unauthenticated — for load balancer probes)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", ...db.stats() });
  });

  // Listen
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${config.port} already in use`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(config.port, host, () => {
      logger.info(`[mesh-master] Embedded master running on http://${host}:${config.port}`);
      logger.info(`[mesh-master] Dashboard: http://localhost:${config.port}/dashboard`);
      resolve();
    });
  });

  // Read or ensure API key for return value
  const apiKey = db.getConfig("api_key") || "";

  // Return handle for lifecycle management
  return {
    port: config.port,
    db,
    hub,
    apiKey,
    stop: async () => {
      logger.info("[mesh-master] Embedded master stopping...");
      hub.stop();
      router.stop();
      db.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        setTimeout(resolve, 3000); // Force after 3s
      });
      closeFileLogging();
      logger.info("[mesh-master] Embedded master stopped.");
    },
  };
}
