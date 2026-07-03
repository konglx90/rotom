/**
 * Filesystem-path validation helpers shared across master/api handlers.
 *
 * `validateWorkingDir` was previously duplicated byte-for-byte in
 * `api/groups.ts` and `api/issues.ts`; both handlers need to coerce a
 * user-supplied working_dir string into a resolved, accessible directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ValidateWorkingDirResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Coerce a user-supplied working_dir string into a resolved, accessible
 * directory path. Expands `~` / `~/...`, requires an absolute path, and
 * verifies the path is an existing directory with R+X permissions.
 */
export function validateWorkingDir(input: unknown): ValidateWorkingDirResult {
  if (typeof input !== "string") return { ok: false, error: "working_dir must be a string" };
  const raw = input.trim();
  if (!raw) return { ok: false, error: "working_dir is empty" };

  let expanded = raw;
  if (raw === "~") expanded = os.homedir();
  else if (raw.startsWith("~/")) expanded = path.join(os.homedir(), raw.slice(2));

  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `working_dir must be an absolute path (got: ${raw})` };
  }
  const resolved = path.resolve(expanded);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, error: `工作目录不存在: ${resolved}` };
    return { ok: false, error: `工作目录无法访问: ${resolved} (${err?.code ?? err?.message ?? "unknown"})` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `工作目录不是一个目录: ${resolved}` };
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return { ok: false, error: `工作目录无读取/进入权限: ${resolved}` };
  }
  return { ok: true, path: resolved };
}
