/**
 * rotom collab — collaboration create/conclude.
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  fail,
  flagStr,
  flagInt,
  requireFlag,
} from "./common.js";

export async function cmdCollab(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "create") {
    const groupId = rest[1];
    if (!groupId) fail("usage: rotom collab create <groupId> --title T --goal G --participants a,b[,c] [--max-rounds 3] [--owner X]");
    const participants = requireFlag(flags, "participants").split(",").map((s) => s.trim()).filter(Boolean);
    if (participants.length < 2) fail("--participants must list at least 2 agents (comma-separated)");
    const body: any = {
      title: requireFlag(flags, "title"),
      collaborationGoal: requireFlag(flags, "goal"),
      participants,
      maxRounds: flagInt(flags, "max-rounds") ?? 3,
      owner: flagStr(flags, "owner") || "",
      createdBy: agent.name,
    };
    const data = await api(agent, "POST", `/groups/${encodeURIComponent(groupId)}/collaborations`, body);
    printJson(data);
    return;
  }
  if (sub === "conclude") {
    const id = rest[1]; if (!id) fail("usage: rotom collab conclude <issueId> --summary S");
    const summary = requireFlag(flags, "summary");
    const data = await api(agent, "POST", `/issues/${encodeURIComponent(id)}/conclude-collaboration`, { summary });
    printJson(data);
    return;
  }
  fail(`unknown collab subcommand: ${sub || "(none)"}`);
}
