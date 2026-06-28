/**
 * Digital Employee Mesh — REST API
 *
 * Dashboard endpoints are open (no login). Agent-token endpoints expect a
 * `Bearer mesh_xxx` header and reject anonymous calls inline.
 */

import { Router as ExpressRouter, type Request, type Response, type NextFunction } from "express";
import type { MeshDb } from "../db.js";
import { AuthService, hashToken } from "../auth.js";
import type { WSHub } from "../ws-hub.js";
import type { Router } from "../router.js";
import { ShareTokenStore } from "../share-tokens.js";

import { createLogger } from "../../shared/logger.js";
import { registerAgentRoutes } from "./agents.js";
import { registerDomainRoutes } from "./domains.js";
import { registerMessageRoutes } from "./messages.js";
import { registerGroupRoutes } from "./groups.js";
import { registerIssueRoutes } from "./issues.js";
import { registerNoteRoutes } from "./notes.js";
import { registerArtifactRoutes } from "./artifacts.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerE2edRoutes } from "./e2ed.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerScheduleRoutes } from "./schedules.js";
import { registerShareRoutes } from "./share.js";
import { registerGuidanceTemplateRoutes } from "./guidance-templates.js";

const log = createLogger("mesh-api");

// ---------------------------------------------------------------------------
// Create API router
// ---------------------------------------------------------------------------

export function createApi(db: MeshDb, sharedAuth?: AuthService, hub?: WSHub, router?: Router, serverPort?: number, shareStore?: ShareTokenStore): ExpressRouter {
  const apiRouter = ExpressRouter();
  const auth = sharedAuth ?? new AuthService(db);
  const shareTokens = shareStore ?? new ShareTokenStore();

  // ── Request logging middleware ──────────────────────────────────────────
  apiRouter.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  // ── Permissive auth middleware ──────────────────────────────────────────
  apiRouter.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(200).end();
      return;
    }

    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      const token = header.slice(7);
      if (token.startsWith("mesh_")) {
        const agent = db.getAgentByTokenHash(hashToken(token));
        if (agent) {
          (req as any).agentAuth = { name: agent.name, id: agent.id };
        }
      }
    }
    next();
  });

  // ── Register route modules ─────────────────────────────────────────────
  registerAgentRoutes(apiRouter, db, auth, hub, serverPort);
  registerDomainRoutes(apiRouter, db);
  registerMessageRoutes(apiRouter, db, auth, hub, router);
  registerGroupRoutes(apiRouter, db, auth, hub);
  registerIssueRoutes(apiRouter, db, auth, hub);
  registerNoteRoutes(apiRouter, db);
  registerArtifactRoutes(apiRouter, db);
  registerUploadRoutes(apiRouter, db);
  registerE2edRoutes(apiRouter, db);
  registerSessionRoutes(apiRouter, db, auth, hub);
  registerScheduleRoutes(apiRouter, db);
  registerShareRoutes(apiRouter, db, shareTokens);
  registerGuidanceTemplateRoutes(apiRouter, db);

  return apiRouter;
}
