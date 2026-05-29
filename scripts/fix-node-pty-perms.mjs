#!/usr/bin/env node
/**
 * pnpm sometimes strips the +x bit from node-pty's prebuilt `spawn-helper`
 * during extraction. Without it, posix_spawnp fails with EACCES and every
 * web-terminal connection dies with "posix_spawnp failed". This script
 * restores the bit after install so a fresh clone just works.
 *
 * No-op if node-pty isn't installed (optional dependency).
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let ptyPkgDir;
try {
  ptyPkgDir = path.dirname(require.resolve("node-pty/package.json"));
} catch {
  process.exit(0); // not installed → nothing to do
}

const prebuildsDir = path.join(ptyPkgDir, "prebuilds");
if (!fs.existsSync(prebuildsDir)) process.exit(0);

let fixed = 0;
for (const entry of fs.readdirSync(prebuildsDir)) {
  const helper = path.join(prebuildsDir, entry, "spawn-helper");
  if (!fs.existsSync(helper)) continue;
  try {
    const stat = fs.statSync(helper);
    // Add user/group/other execute bits if any are missing.
    const wantMode = stat.mode | 0o111;
    if (wantMode !== stat.mode) {
      fs.chmodSync(helper, wantMode);
      fixed++;
    }
  } catch (err) {
    console.warn(`[fix-node-pty] could not chmod ${helper}:`, err.message);
  }
}

if (fixed > 0) {
  console.log(`[fix-node-pty] restored +x on ${fixed} spawn-helper binar${fixed === 1 ? "y" : "ies"}`);
}
