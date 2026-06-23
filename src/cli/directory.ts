/**
 * rotom directory — list agents.
 */

import { type ResolvedAgent, api, flagStr, printTable } from "./common.js";

export async function cmdDirectory(agent: ResolvedAgent, flags: Record<string, string | boolean>): Promise<void> {
  const route = flags.online === true ? "/agents/online" : "/agents";
  let data = await api(agent, "GET", route);
  const domain = flagStr(flags, "domain");
  if (domain) data = data.filter((a: any) => a.domain === domain);
  printTable(
    data.map((a: any) => ({
      name: a.name,
      domain: a.domain || "-",
      status: a.status,
      description: (a.description || "").slice(0, 60),
    })),
    ["name", "domain", "status", "description"],
  );
}
