/**
 * rotom executor — start executor workers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { installRoot, fail, flagStr } from "./common.js";

export async function cmdExecutor(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const root = installRoot();
  const distJs = path.join(root, "dist", "executor", "index.js");
  const srcTs  = path.join(root, "src", "executor", "index.ts");

  const fwd: string[] = [];
  const cfg = flagStr(flags, "config");
  if (cfg) fwd.push("--config", cfg);
  for (const a of rest) fwd.push(a);

  let useTsx = false;
  let entry: string;
  if (fs.existsSync(distJs)) {
    entry = distJs;
  } else if (fs.existsSync(srcTs)) {
    const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
    if (!fs.existsSync(tsxBin)) {
      fail(`tsx not found at ${tsxBin} — required for dev mode. Run \`pnpm install\` first.`);
    }
    entry = tsxBin;
    useTsx = true;
  } else {
    fail(`cannot find executor entry: tried ${distJs} and ${srcTs}`);
  }

  const cmdline = useTsx
    ? [entry, srcTs, ...fwd]
    : [entry, ...fwd];
  const bin = useTsx ? entry : process.execPath;

  await new Promise<void>((resolve) => {
    const child = spawn(bin, cmdline, { stdio: "inherit" });
    const forward = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* already gone */ } };
    process.on("SIGINT",  () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));
    child.on("exit", (code, signal) => {
      if (code !== null && code !== undefined) { process.exit(code); return; }
      const sigNum = signal ? os.constants.signals[signal] : 0;
      process.exit(typeof sigNum === "number" && sigNum > 0 ? 128 + sigNum : 1);
      resolve();
    });
    child.on("error", (err) => fail(`failed to spawn executor: ${err.message}`));
  });
}
