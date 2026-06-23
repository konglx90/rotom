/**
 * rotom master — master lifecycle control (start|stop|restart|status).
 */

import { fail, flagStr, runShellScript } from "./common.js";

/**
 * Accept `master:start` colon alias, expand to [`start`, ...rest].
 */
function colonExpand(cmd: string, rest: string[]): string[] {
  const colon = cmd.indexOf(":");
  if (colon === -1) return rest;
  return [cmd.slice(colon + 1), ...rest];
}

export { colonExpand };

export async function cmdMaster(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  const args: string[] = [];
  switch (sub) {
    case "start":
    case "stop":
    case "status":
    case "restart":
      args.push(sub); break;
    default:
      fail(
        "usage: rotom master <start|stop|status|restart> [--daemon] [--port N] [--host A] [--data D] [--dev]\n" +
        "       (also accepts colon form: rotom master:start | master:stop | master:status | master:restart)",
      );
  }
  if (flags.daemon === true && (sub === "start" || sub === "restart")) args.push("--daemon");
  if (flags.dev === true && sub === "start") args.push("--dev");
  const port = flagStr(flags, "port");   if (port && sub === "start") args.push("--port", port);
  const host = flagStr(flags, "host");   if (host && sub === "start") args.push("--host", host);
  const data = flagStr(flags, "data");   if (data && sub === "start") args.push("--data", data);
  let code: number;
  try { code = await runShellScript("bin/mesh-master.sh", args); }
  catch (e) { fail(`failed to invoke bin/mesh-master.sh: ${(e as Error).message}`); }
  process.exit(code);
}
