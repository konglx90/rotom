/**
 * Image upload storage helpers.
 *
 * Uploads land under `~/.rotom/uploads/<YYYY-MM>/<groupId>/<file>` so that:
 *   • per-month top-level buckets make "delete everything older than X" a
 *     single `rm -rf` on a date-prefixed directory
 *   • per-group subdirectory keeps a single upload dir from filling up and
 *     gives the URL a natural groupId segment for auth/scoping
 *   • filename embeds `YYYYMMDD-HHmmss` so files remain sortable/cleanable
 *     even if someone flattens the month buckets later
 *
 * URL → disk mapping is `/api/uploads/<groupId>/<filename>` (no DB lookup).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { toBeijingCompact, toBeijingYearMonth } from "../shared/time.js";

export const UPLOADS_ROOT = path.join(os.homedir(), ".rotom", "uploads");

/** Hard ceiling on a single upload's decoded byte length (matches express.json
 *  limit in server.ts — keep them in sync). */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function extFromMime(mimeType: string): string | null {
  return MIME_TO_EXT[mimeType.toLowerCase()] ?? null;
}

export function mimeFromExt(ext: string): string | null {
  return EXT_TO_MIME[ext.toLowerCase().replace(/^\./, "")] ?? null;
}

export function isAllowedMime(mimeType: string): boolean {
  return mimeType.toLowerCase() in MIME_TO_EXT;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  mimeType?: string;
  ext?: string;
}

/** Validate an inbound upload. Returns a normalised mimeType + ext on success. */
export function validateUpload(
  fileName: unknown,
  mimeType: unknown,
  sizeBytes: number,
): ValidationResult {
  if (typeof fileName !== "string" || !fileName.trim()) {
    return { ok: false, error: "fileName is required" };
  }
  if (typeof mimeType !== "string" || !isAllowedMime(mimeType)) {
    return {
      ok: false,
      error: `mimeType not supported (allowed: ${Object.keys(MIME_TO_EXT).join(", ")})`,
    };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "size must be > 0" };
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `file too large: ${sizeBytes} bytes > ${MAX_UPLOAD_BYTES} bytes`,
    };
  }
  const ext = extFromMime(mimeType)!;
  return { ok: true, mimeType: mimeType.toLowerCase(), ext };
}

/** `<YYYYMMDD-HHmmss>-<rand6hex>.<ext>` — sortable + collision-resistant. */
export function generateUploadFileName(ext: string): string {
  const stamp = toBeijingCompact();
  const rand = randomBytes(3).toString("hex");
  return `${stamp}-${rand}.${ext}`;
}

/**
 * Resolve the on-disk directory for a (groupId, now) tuple, creating it.
 * Returns `{ dir, monthDir }` so callers can build the absolute path.
 */
export function resolveUploadDir(groupId: string): { dir: string; monthDir: string } {
  const monthDir = toBeijingYearMonth();
  const dir = path.join(UPLOADS_ROOT, monthDir, groupId);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, monthDir };
}

/**
 * Resolve and verify an absolute path for an inbound (groupId, fileName)
 * GET request. Returns null when the path would escape the group's upload
 * directory or when fileName is malformed.
 */
export function safeResolveUploadPath(groupId: string, fileName: string): string | null {
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) return null;
  if (fileName.startsWith(".")) return null;
  // Walk every <YYYY-MM> bucket — uploads historically lived under any month.
  // Cheap operation: typically <100 month buckets.
  if (!fs.existsSync(UPLOADS_ROOT)) return null;
  for (const entry of fs.readdirSync(UPLOADS_ROOT)) {
    const candidate = path.join(UPLOADS_ROOT, entry, groupId, fileName);
    const resolved = path.resolve(candidate);
    const groupRoot = path.resolve(path.join(UPLOADS_ROOT, entry, groupId));
    if (!resolved.startsWith(groupRoot + path.sep)) continue;
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}
