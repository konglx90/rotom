import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import { listRequirements, getRequirement } from "../../e2ed/requirement.js";
import { computeMetrics, getTimeline } from "../../e2ed/metrics.js";

export function registerE2edRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
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
}
