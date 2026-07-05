/**
 * rotom run — 一站式启动入口(等价 bin/rotom-up.sh start,可选 federation 角色)。
 *
 *   rotom run opc          启动 master + 自动 spawn executor(OPC 模式,默认)
 *   rotom run federation   启动协调 master + 自动 spawn executor(federation 中心节点)
 *
 * 与 `pnpm start` 的区别:走 CLI 统一入口,且 federation 子命令会自动注入
 * ROTOM_MASTER_ROLE=coordination,免去手写环境变量。
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fail, installRoot } from "./common.js";

function runRotomUp(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const scriptPath = path.join(installRoot(), "bin/rotom-up.sh");
  if (!fs.existsSync(scriptPath)) {
    fail(`shell script not found: ${scriptPath}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath, ...args], {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function cmdRun(rest: string[]): Promise<void> {
  const sub = rest[0];
  const passthrough = rest.slice(1);

  let env: NodeJS.ProcessEnv = {};
  switch (sub) {
    case "opc":
      break;
    case "federation":
      env.ROTOM_MASTER_ROLE = "coordination";
      break;
    default:
      fail(
        "usage: rotom run <opc|federation> [--port N] [--host A] [--data D] [--no-build] [--dev]\n" +
        "       opc          启动 master + executor(OPC 模式,默认)\n" +
        "       federation   启动协调 master + executor(ROTOM_MASTER_ROLE=coordination)",
      );
  }

  const code = await runRotomUp(passthrough, env);
  process.exit(code);
}
