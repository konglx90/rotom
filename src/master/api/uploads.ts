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
import path from "node:path";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";
import {
  UPLOADS_ROOT,
  generateUploadFileName,
  mimeFromExt,
  safeResolveUploadPath,
  resolveUploadDir,
  validateUpload,
} from "../uploads.js";

const log = createLogger("mesh-api");

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Filename pattern: `YYYYMMDD-HHmmss-<rand6hex>.<ext>` — see generateUploadFileName.
// The leading 15 chars encode the upload timestamp in Asia/Shanghai (UTC+8).
const FILENAME_TIMESTAMP_RE = /^(\d{8})-(\d{6})-/;

interface UploadListItem {
  url: string;
  groupId: string;
  groupName: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string; // ISO 8601 UTC
}

/**
 * Walk `UPLOADS_ROOT` and collect all uploaded files for the gallery tab.
 *
 * Layout: `~/.rotom/uploads/<YYYY-MM>/<groupId>/<YYYYMMDD-HHmmss>-<rand>.<ext>`
 * We scan month buckets → group dirs → files, then sort by createdAt desc.
 *
 * `groupIdFilter` narrows to one group; `limit` caps the page size; `cursor`
 * is the last (createdAt, fileName) from the previous page for stable
 * forward pagination.
 */
function scanUploads(
  db: MeshDb,
  groupIdFilter?: string,
): UploadListItem[] {
  if (!fs.existsSync(UPLOADS_ROOT)) return [];

  const items: UploadListItem[] = [];

  for (const monthEntry of fs.readdirSync(UPLOADS_ROOT)) {
    if (monthEntry.startsWith(".")) continue;
    const monthDir = path.join(UPLOADS_ROOT, monthEntry);
    let groupEntries: string[];
    try {
      groupEntries = fs.readdirSync(monthDir);
    } catch {
      continue;
    }

    for (const groupId of groupEntries) {
      if (groupId.startsWith(".")) continue;
      if (groupIdFilter && groupId !== groupIdFilter) continue;

      const groupDir = path.join(monthDir, groupId);
      let fileEntries: string[];
      try {
        fileEntries = fs.readdirSync(groupDir);
      } catch {
        continue;
      }

      // Resolve group name once per group dir. Archived groups still show
      // their images — archive doesn't delete files.
      const group = db.getGroupById(groupId);
      const groupName = group
        ? group.name + (group.archived_at ? " (已归档)" : "")
        : "(未知群)";

      for (const fileName of fileEntries) {
        if (fileName.startsWith(".")) continue;
        const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
        const mimeType = mimeFromExt(ext);
        if (!mimeType) continue; // not an allowed image ext

        const abs = path.join(groupDir, fileName);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        // Prefer the timestamp embedded in the filename (matches upload
        // instant, not filesystem mtime which can shift on copy). Fall back
        // to mtime if the pattern doesn't match (legacy/renamed files).
        let createdAt: string;
        const m = FILENAME_TIMESTAMP_RE.exec(fileName);
        if (m) {
          const [ , ymd, hms ] = m;
          // YYYYMMDD-HHmmss interpreted as Shanghai time → UTC ISO
          const y = +ymd.slice(0, 4);
          const mo = +ymd.slice(4, 6);
          const d = +ymd.slice(6, 8);
          const h = +hms.slice(0, 2);
          const mi = +hms.slice(2, 4);
          const s = +hms.slice(4, 6);
          // Construct as UTC then subtract 8h to get the moment that was
          // "local 8" at upload time. Equivalent to treating the digits as
          // Asia/Shanghai wall clock.
          const utcMs = Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 60 * 60 * 1000;
          createdAt = new Date(utcMs).toISOString();
        } else {
          createdAt = stat.mtime.toISOString();
        }

        items.push({
          url: `/api/uploads/${encodeURIComponent(groupId)}/${encodeURIComponent(fileName)}`,
          groupId,
          groupName,
          fileName,
          mimeType,
          size: stat.size,
          createdAt,
        });
      }
    }
  }

  // Sort by createdAt desc; tiebreak by fileName for stable pagination.
  items.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 :
    a.fileName < b.fileName ? 1 : a.fileName > b.fileName ? -1 : 0,
  );
  return items;
}

/** Encode/decode a cursor of (createdAt, fileName). Opaque to the client. */
function encodeCursor(createdAt: string, fileName: string): string {
  return Buffer.from(`${createdAt}|${fileName}`).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; fileName: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx < 0) return null;
    return { createdAt: decoded.slice(0, idx), fileName: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function registerUploadRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  // ── Gallery listing ───────────────────────────────────────────────────
  // GET /api/uploads?groupId=&limit=&cursor= — cross-group index of all
  // uploaded images, newest first. Used by the toolbox 图册 tab.
  apiRouter.get("/uploads", (req, res) => {
    const groupId = typeof req.query.groupId === "string" ? req.query.groupId : undefined;
    let limit = 100;
    if (req.query.limit) {
      const n = Number(req.query.limit);
      if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 500);
    }
    const cursorStr = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const cursor = cursorStr ? decodeCursor(cursorStr) : null;

    const all = scanUploads(db, groupId);

    // Forward pagination: drop everything that sorts at or before the cursor
    // (createdAt, fileName). Items are sorted desc, so we want items strictly
    // "smaller" than the cursor.
    let startIdx = 0;
    if (cursor) {
      const i = all.findIndex(
        (it) => it.createdAt === cursor.createdAt && it.fileName === cursor.fileName,
      );
      if (i >= 0) startIdx = i + 1;
    }

    const page = all.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + page.length < all.length && page.length > 0
        ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].fileName)
        : null;

    res.json({ items: page, nextCursor });
  });

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
