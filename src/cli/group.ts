/**
 * rotom group — group list/members/history/send/archive/unarchive.
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagInt,
  flagStr,
} from "./common.js";

export async function cmdGroup(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "list") {
    const data = await api(agent, "GET", "/groups");
    printTable(
      data.map((g: any) => ({
        id: g.id,
        name: g.name,
        members: (g.members?.length ?? 0),
        created_at: g.created_at,
        archived: g.archived_at ? "yes" : "",
      })),
      ["id", "name", "members", "created_at", "archived"],
    );
    return;
  }
  if (sub === "members") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group members <groupId>");
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}`);
    printTable(
      (data.members || []).map((m: any) => ({ agent_name: m.agent_name, joined_at: m.joined_at })),
      ["agent_name", "joined_at"],
    );
    return;
  }
  if (sub === "history") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group history <groupId>");
    const limit = flagInt(flags, "limit") ?? 50;
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}/messages?limit=${limit}`);
    printTable(
      data.map((m: any) => ({
        time: m.created_at,
        sender: m.sender,
        content: (m.content || "").replace(/\s+/g, " ").slice(0, 80),
      })),
      ["time", "sender", "content"],
    );
    return;
  }
  if (sub === "send") {
    const groupId = rest[1]; const target = rest[2]; const message = rest.slice(3).join(" ");
    if (!groupId || !target || !message) fail("usage: rotom group send <groupId> <target> <message...>");
    const data = await api(agent, "POST", `/cli/groups/${encodeURIComponent(groupId)}/send`, { target, message });
    printJson(data);
    return;
  }
  if (sub === "archive") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group archive <groupId>");
    const data = await api(agent, "PATCH", `/groups/${encodeURIComponent(groupId)}`, { archived: true });
    printJson(data);
    return;
  }
  if (sub === "unarchive") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group unarchive <groupId>");
    const data = await api(agent, "PATCH", `/groups/${encodeURIComponent(groupId)}`, { archived: false });
    printJson(data);
    return;
  }
  fail(`unknown group subcommand: ${sub || "(none)"}`);
}
