/**
 * rotom link — link daemon CLI 入口。
 *
 *   rotom link join <coordEndpoint> [--hostname <name>]   一次性:probe coord,生成 masterId,写 link.json
 *   rotom link start [--port N]                            启动 daemon(读 ~/.rotom/link.json)
 *   rotom link stop                                        停 daemon
 *   rotom link restart                                     重启
 *   rotom link status                                      查状态(含 /health 探活)
 *   rotom link logs                                        打印最近 200 行日志
 *
 * link.json 持久化 masterId(永不改),hostname 可改(--hostname 覆盖)。
 */

import os from "node:os";
import { fail, flagStr, runShellScript } from "./common.js";
import { linkJoin } from "../link/server.js";

export async function cmdLink(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (!sub) {
    fail(
      "usage: rotom link <join|start|stop|restart|status|logs> [args]\n" +
      "  join <coordEndpoint> [--hostname <name>]   生成 masterId + 写 link.json (一次性)\n" +
      "  start [--port N]                          启动 link daemon (默认端口 28900)\n" +
      "  stop / restart / status / logs",
    );
  }
  const args = rest.slice(1);

  switch (sub) {
    case "join": {
      const coordEndpoint = args[0];
      if (!coordEndpoint) {
        fail("usage: rotom link join <coordEndpoint> [--hostname <name>]\n  e.g. ws://192.168.1.5:28800");
      }
      const hostname = flagStr(flags, "hostname") || process.env.ROTOM_HOSTNAME || os.hostname();
      await linkJoin(coordEndpoint, hostname);
      process.stdout.write(
        `✅ joined. link.json written. Run \`rotom link start\` to launch the daemon.\n`,
      );
      return;
    }
    case "start":
    case "stop":
    case "restart":
    case "status":
    case "logs": {
      const code = await runShellScript("bin/rotom-link.sh", [sub, ...args]);
      process.exit(code);
    }
    default:
      fail(`unknown link subcommand: ${sub}\nRun 'rotom link' for usage.`);
  }
}
