import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import {
  listRequirements,
  getRequirement,
  createRequirement,
  closeRequirement,
} from "../../e2ed/requirement.js";
import { computeMetrics, getTimeline } from "../../e2ed/metrics.js";
import { startDeliver, startReview } from "../../e2ed/pipeline.js";

export function registerE2edRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  // ── GET ────────────────────────────────────────────────────────────────

  apiRouter.get("/e2ed/groups", (_req, res) => {
    const reqs = listRequirements(db);
    res.json(reqs);
  });

  apiRouter.get("/e2ed/groups/:groupId", (req, res) => {
    const meta = getRequirement(db, req.params.groupId);
    if (!meta) return res.status(404).json({ error: "Not found" });
    res.json(meta);
  });

  apiRouter.get("/e2ed/groups/:groupId/metrics", (req, res) => {
    const metrics = computeMetrics(db, req.params.groupId);
    if (!metrics) return res.status(404).json({ error: "Not found" });
    res.json(metrics);
  });

  apiRouter.get("/e2ed/groups/:groupId/timeline", (req, res) => {
    const timeline = getTimeline(db, req.params.groupId);
    res.json(timeline);
  });

  // ── POST ───────────────────────────────────────────────────────────────

  /** Create a new requirement */
  apiRouter.post("/e2ed/groups", (req, res) => {
    const { title, text, source, cwd } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text is required" });
      return;
    }

    const { groupId, meta } = createRequirement(db, {
      title: title || "",
      text,
      source: source || "api",
      workingDir: cwd || undefined,
    });

    res.status(201).json({ groupId, status: meta.status });
  });

  /** Start delivery pipeline */
  apiRouter.post("/e2ed/groups/:groupId/deliver", (req, res) => {
    const { groupId } = req.params;
    const meta = getRequirement(db, groupId);
    if (!meta) return res.status(404).json({ error: "Not found" });

    const { planOnly, codeOnly, fix, cwd } = req.body;

    try {
      startDeliver(db, groupId, {
        cwd: cwd || undefined,
        fix: !!fix,
        planOnly: !!planOnly,
        codeOnly: !!codeOnly,
      });
      res.status(201).json({ ok: true, groupId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Start review pipeline */
  apiRouter.post("/e2ed/groups/:groupId/review", (req, res) => {
    const { groupId } = req.params;
    const meta = getRequirement(db, groupId);
    if (!meta) return res.status(404).json({ error: "Not found" });

    const { type, cwd } = req.body;

    try {
      startReview(db, groupId, {
        cwd: cwd || undefined,
        reviewType: type || undefined,
      });
      res.status(201).json({ ok: true, groupId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Close a requirement */
  apiRouter.post("/e2ed/groups/:groupId/close", (req, res) => {
    const { groupId } = req.params;

    try {
      const meta = closeRequirement(db, groupId);
      res.json({ ok: true, groupId, status: meta.status });
    } catch (err: any) {
      if (err.message.includes("not found")) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(400).json({ error: err.message });
      }
    }
  });
}
