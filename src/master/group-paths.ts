/**
 * Shared helpers for resolving per-group on-disk paths.
 *
 * Centralises the "where does this group's working directory live" rule so
 * both the artifacts REST endpoints and the web-terminal PTY hub agree on
 * the same cwd. Previously this lived inline in api.ts; pulling it out
 * avoids importing api.ts (and Express) from non-HTTP modules.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeshDb } from "./db.js";

/** Root directory under which per-group working dirs (artifacts) live. */
export const ARTIFACTS_ROOT = path.join(os.homedir(), ".rotom", "artifacts");

/**
 * Legacy root from before the `results → artifacts` rename. Kept as a
 * read-only fallback so a group's pre-rename data still resolves correctly
 * if the one-shot data migration missed it (or was run on an older DB
 * whose `working_dir` column was back-filled to the legacy path).
 */
const LEGACY_RESULTS_ROOT = path.join(os.homedir(), ".rotom", "results");

/** Absolute default working dir for a group — used as cwd when no override. */
export function defaultGroupWorkingDir(groupId: string): string {
  return path.join(ARTIFACTS_ROOT, groupId);
}

/**
 * Resolve the directory the artifacts panel / terminal should use for a group.
 *
 * Prefers the group's configured `working_dir` (an absolute path the agent
 * actually runs in), falling back to the default `~/.rotom/artifacts/<groupId>`.
 *
 * Backward-compat: if neither override nor the default artifacts dir exists
 * on disk, fall back to the legacy `~/.rotom/results/<groupId>` (covers
 * `working_dir` values persisted against the pre-rename path).
 */
export function resolveGroupArtifactRoot(db: MeshDb, groupId: string): string {
  const group = db.getGroupById(groupId);
  const dir = group?.working_dir?.trim();
  if (dir && path.isAbsolute(dir)) {
    if (fs.existsSync(dir)) return dir;
    // Stored working_dir is stale — fall through to the default + legacy
    // fallback below so a pre-rename group keeps resolving.
  }

  const defaultDir = defaultGroupWorkingDir(groupId);
  if (fs.existsSync(defaultDir)) return defaultDir;

  const legacyDir = path.join(LEGACY_RESULTS_ROOT, groupId);
  if (fs.existsSync(legacyDir)) return legacyDir;

  return defaultDir;
}

/**
 * Resolve the working directory for a specific (group, agent) pair.
 *
 * Three-tier fallback:
 *  1. per-(group, agent) override in `group_member_settings`
 *  2. group's `working_dir` (when set to an absolute path)
 *  3. `~/.rotom/artifacts/<groupId>` default (with legacy results fallback
 *     for groups whose data migration was incomplete)
 *
 * Used at issue-assignment time to compute the cwd that should be recorded
 * on the issue. Executor workers continue to use their own per-group mapping
 * (`executor.config.json.workingDirMap`); this function is the master-side
 * authoritative resolution only.
 */
export function resolveGroupAgentWorkingDir(
  db: MeshDb,
  groupId: string,
  agentName: string,
): string {
  const override = db.getGroupMemberSetting(groupId, agentName);
  if (override && fs.existsSync(override)) return override;

  const group = db.getGroupById(groupId);
  const dir = group?.working_dir?.trim();
  if (dir && path.isAbsolute(dir) && fs.existsSync(dir)) return dir;

  const defaultDir = defaultGroupWorkingDir(groupId);
  if (fs.existsSync(defaultDir)) return defaultDir;

  const legacyDir = path.join(LEGACY_RESULTS_ROOT, groupId);
  if (fs.existsSync(legacyDir)) return legacyDir;

  return defaultDir;
}
