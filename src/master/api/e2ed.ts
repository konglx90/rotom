import { type Router as ExpressRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MeshDb } from "../db.js";
import {
  listRequirements,
  getRequirement,
  getRequirementText,
  readArtifactFile,
  createRequirement,
  closeRequirement,
} from "../../e2ed/requirement.js";
import { computeMetrics, getTimeline } from "../../e2ed/metrics.js";
import { startDeliver, startReview } from "../../e2ed/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const guidePath = path.resolve(__dirname, "../../../docs/e2ed.md");

export function registerE2edRoutes(
  apiRouter: ExpressRouter,
  db: MeshDb,
): void {
  // ── GET ────────────────────────────────────────────────────────────────

  /** Serve E2ED documentation (single source of truth for project + dashboard) */
  apiRouter.get("/e2ed/guide", (_req, res) => {
    try {
      const content = fs.readFileSync(guidePath, "utf-8");
      res.type("text/markdown").send(content);
    } catch {
      res.status(404).json({ error: "Guide not found" });
    }
  });

  apiRouter.get("/e2ed/groups", (_req, res) => {
    const reqs = listRequirements(db);
    // Enrich with title and workingDir from groups table
    const enriched = reqs.map((r) => {
      const group = db.getGroupById(r.reqId);
      return { ...r, title: group?.name || r.reqId, workingDir: group?.working_dir || null };
    });
    res.json(enriched);
  });

  apiRouter.get("/e2ed/groups/:groupId", (req, res) => {
    const meta = getRequirement(db, req.params.groupId);
    if (!meta) return res.status(404).json({ error: "Not found" });

    // Enrich with title and workingDir from group record
    const group = db.getGroupById(req.params.groupId);
    res.json({ ...meta, title: group?.name || meta.reqId, workingDir: group?.working_dir || null });
  });

  /** Get requirement text content */
  apiRouter.get("/e2ed/groups/:groupId/text", (req, res) => {
    const meta = getRequirement(db, req.params.groupId);
    if (!meta) return res.status(404).json({ error: "Not found" });
    const text = getRequirementText(req.params.groupId);
    res.json({ text: text || "" });
  });

  /** Read an artifact file (plan, review report, reflection, etc.) */
  apiRouter.get("/e2ed/groups/:groupId/artifacts/*", (req, res) => {
    const meta = getRequirement(db, req.params.groupId);
    if (!meta) return res.status(404).json({ error: "Not found" });

    const wildcard = (req.params as unknown as Record<string, string>)["0"];
    const segments = wildcard?.split("/") || [];
    const content = readArtifactFile(req.params.groupId, ...segments);
    if (!content) return res.status(404).json({ error: "Artifact not found" });

    res.type("text/plain").send(content);
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
