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
  isPretty,
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
    const members = (data.members || []) as Array<{
      agent_name: string;
      joined_at: string;
      status?: string;
      profile?: { position?: string; bio?: string; category?: string } | null;
    }>;
    // 非.pretty 走完整 JSON,保留 profile 嵌套结构供 agent 程序化读取;
    // .pretty 走扁平表格,bio 截断 40 字符避免撑爆终端。
    if (!isPretty()) {
      printJson(members);
      return;
    }
    printTable(
      members.map((m) => ({
        agent_name: m.agent_name,
        position: m.profile?.position ?? "",
        bio: (m.profile?.bio ?? "").slice(0, 40),
        category: m.profile?.category ?? "",
        status: m.status ?? "",
      })),
      ["agent_name", "position", "bio", "category", "status"],
    );
    return;
  }
  if (sub === "history") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group history <groupId>");
    const limit = flagInt(flags, "limit") ?? 50;
    const contentLen = flagInt(flags, "content-len") ?? 200;
    const hideExec = flags["no-exec"] === true;
    const clean = flags["clean"] !== false;
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}/messages?limit=${limit}`);
    // --no-exec 过滤 sender=system 且以「请求执行命令:」开头的 shell 调用通知,
    // 这类消息占行多但很少是用户想看的回复主体。
    const filtered = hideExec
      ? data.filter((m: any) => !(m.sender === "system" && /^请求执行命令[::]/.test(m.content || "")))
      : data;
    printTable(
      filtered.map((m: any) => {
        // --clean 去掉行内 [xxx:yyy]...[/xxx:yyy] 形式的 agent 状态/工具标记
        // ([status:thinking] / [tool:exec] / [tool-result:exec] 等),只留自然语言主体。
        let content = (m.content || "").replace(/\s+/g, " ");
        if (clean) {
          content = content
            .replace(/\[(\w[\w-]*:\w[\w-]*)\].*?\[\/\1\]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        }
        return {
          time: m.created_at,
          sender: m.sender,
          content: content.slice(0, contentLen),
        };
      }),
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
