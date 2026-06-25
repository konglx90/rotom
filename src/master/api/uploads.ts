/**
 * Image upload REST endpoints.
 *
 *   POST   /api/uploads                JSON body { groupId, fileName, mimeType, dataBase64 }
 *                                       → { url, name, size, mimeType }
 *   GET    /api/uploads/:groupId/:filename  raw bytes w/ Content-Type
 *
 * POST is JSON+base64 rather than multipart/form-data to avoid pulling in a
 * new parser dep. Base64 inflation is ~33%, which is fine after the dashboard's
 * client-side Canvas compression (typical <500KB per image).
 *
 * GET serves bytes straight from disk with a 1-year immutable cache header —
 * filenames embed a random suffix so they're effectively write-once.
 */

import { type Router as ExpressRouter } from "express";
import fs from "node:fs";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";
import {
  generateUploadFileName,
  mimeFromExt,
  safeResolveUploadPath,
  resolveUploadDir,
  validateUpload,
} from "../uploads.js";

const log = createLogger("mesh-api");

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function registerUploadRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  apiRouter.post("/uploads", (req, res) => {
    const { groupId, fileName, mimeType, dataBase64 } = req.body || {};

    if (typeof groupId !== "string" || !groupId.trim()) {
      res.status(400).json({ error: "groupId is required" });
      return;
    }
    const group = db.getGroupById(groupId);
    if (!group) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    if (group.archived_at) {
      res.status(403).json({ error: "Group is archived, cannot upload" });
      return;
    }
    if (typeof dataBase64 !== "string" || !BASE64_RE.test(dataBase64)) {
      res.status(400).json({ error: "dataBase64 must be valid base64" });
      return;
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(dataBase64, "base64");
    } catch (e: any) {
      res.status(400).json({ error: `base64 decode failed: ${e?.message ?? "unknown"}` });
      return;
    }

    const v = validateUpload(fileName, mimeType, buf.length);
    if (!v.ok || !v.ext || !v.mimeType) {
      res.status(400).json({ error: v.error });
      return;
    }

    const storedName = generateUploadFileName(v.ext);
    const { dir } = resolveUploadDir(groupId);
    const absPath = `${dir}/${storedName}`;
    try {
      fs.writeFileSync(absPath, buf);
    } catch (e: any) {
      log.error(`upload write failed: ${e?.code ?? e?.message ?? e}`);
      res.status(500).json({ error: `write failed: ${e?.code ?? e?.message ?? "unknown"}` });
      return;
    }

    const url = `/api/uploads/${encodeURIComponent(groupId)}/${encodeURIComponent(storedName)}`;
    log.info(`upload stored: group=${groupId} mime=${v.mimeType} size=${buf.length} → ${url}`);
    res.status(201).json({
      url,
      name: storedName,
      size: buf.length,
      mimeType: v.mimeType,
    });
  });

  apiRouter.get("/uploads/:groupId/:filename", (req, res) => {
    const { groupId, filename } = req.params;
    if (typeof groupId !== "string" || typeof filename !== "string") {
      res.status(400).json({ error: "invalid path" });
      return;
    }
    const abs = safeResolveUploadPath(groupId, filename);
    if (!abs) {
      res.status(404).json({ error: "not found" });
      return;
    }

    // Filename is the source of truth for extension; trust it over query
    // params. Falls back to application/octet-stream for unknown exts (shouldn't
    // happen given the upload whitelist, but defensive).
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    const contentType = mimeFromExt(ext) ?? "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    // Filename is write-once (random suffix + timestamp), so aggressive
    // caching is safe and cuts dashboard re-fetches on history reload.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(abs).pipe(res);
  });
}
