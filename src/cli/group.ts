/**
 * rotom group — group list/members/history/send/archive/unarchive.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagInt,
  flagStr,
} from "./common.js";

// Minimal MIME sniff table — keep it inline; we accept only the 4 formats the
// uploads endpoint allowlists. Anything else is an error before we hit network.
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function guessMime(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

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
  if (sub === "upload") {
    const groupId = rest[1]; const filePath = rest[2];
    if (!groupId || !filePath) fail("usage: rotom group upload <groupId> <filePath> [--markdown]");
    const expanded = filePath.startsWith("~/") ? path.join(process.env.HOME || "", filePath.slice(2)) : filePath;
    if (!fs.existsSync(expanded)) fail(`file not found: ${expanded}`);
    const mimeType = guessMime(expanded);
    if (!mimeType) fail(`unsupported extension (allowed: ${Object.keys(EXT_TO_MIME).join(", ")})`);
    const bytes = fs.readFileSync(expanded);
    // 15MB cap mirrors server-side MAX_UPLOAD_BYTES — fail fast instead of
    // uploading a body the server will reject.
    const MAX = 15 * 1024 * 1024;
    if (bytes.length > MAX) fail(`file too large: ${bytes.length} bytes > ${MAX} bytes`);
    const dataBase64 = bytes.toString("base64");
    const fileName = path.basename(expanded);
    const data = await api(agent, "POST", "/uploads", { groupId, fileName, mimeType, dataBase64 }) as { url: string; name: string; size: number; mimeType: string };
    if (flags.markdown) {
      // Print only the markdown image token; agents / shell pipelines can
      // capture and paste directly into `rotom group send` message body.
      process.stdout.write(`![${fileName}](${data.url})\n`);
    } else {
      printJson(data);
    }
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
