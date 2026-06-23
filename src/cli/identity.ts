/**
 * rotom identity — whoami / status commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ResolvedAgent,
  ROTOM_HOME,
  masterHttpUrl,
  api,
  printJson,
  fail,
  failKind,
} from "./common.js";

export async function cmdWhoami(agent: ResolvedAgent): Promise<void> {
  const data = await api(agent, "GET", "/agents/me");
  printJson(data);
}

function resolveMasterUrlForStatus(): string {
  const env = process.env.ROTOM_MASTER;
  if (env) return masterHttpUrl(env);
  const cfgPath = path.join(ROTOM_HOME, "executor.config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    if (raw?.master) return masterHttpUrl(raw.master);
  } catch { /* ignore */ }
  fail("cannot resolve master URL for status (set ROTOM_MASTER or have executor.config.json)");
}

export async function cmdStatus(_rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const url = resolveMasterUrlForStatus();
  const endpoint = `${url}/api/health`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp: Response | undefined;
    try {
      resp = await fetch(endpoint);
      const data = await resp.json() as any;
      printJson({
        status: resp.ok ? "ok" : "unhealthy",
        master: url,
        total: (data as any).total ?? null,
        online: (data as any).online ?? null,
        domains: (data as any).domains ?? null,
        checkedAt: new Date().toISOString(),
      });
      return;
    } catch (e) {
      const reason = (e as Error).message;
      const partial = resp !== undefined;
      if (attempt < 2 && !partial) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      failKind(partial ? "partial-response" : "network", url, reason, partial ? resp!.status : 0);
    }
  }
}
