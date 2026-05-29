/**
 * Shared helpers for resolving per-group on-disk paths.
 *
 * Centralises the "where does this group's working directory live" rule so
 * both the artifacts REST endpoints and the web-terminal PTY hub agree on
 * the same cwd. Previously this lived inline in api.ts; pulling it out
 * avoids importing api.ts (and Express) from non-HTTP modules.
 */

import os from "node:os";
import path from "node:path";
import type { MeshDb } from "./db.js";

/** Root directory under which per-group working dirs (and artifacts) live. */
export const RESULTS_ROOT = path.join(os.homedir(), ".rotom", "results");

/** Absolute default working dir for a group — used as cwd when no override. */
export function defaultGroupWorkingDir(groupId: string): string {
  return path.join(RESULTS_ROOT, groupId);
}

/**
 * Resolve the directory the artifacts panel / terminal should use for a group.
 *
 * Prefers the group's configured `working_dir` (an absolute path the agent
 * actually runs in), falling back to the default `~/.rotom/results/<groupId>`
 * when it's unset or not absolute.
 */
export function resolveGroupArtifactRoot(db: MeshDb, groupId: string): string {
  const group = db.getGroupById(groupId);
  const dir = group?.working_dir?.trim();
  return dir && path.isAbsolute(dir) ? dir : defaultGroupWorkingDir(groupId);
}
