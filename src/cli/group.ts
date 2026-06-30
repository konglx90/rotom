/**
 * rotom group — group create/list/members/history/send/upload/archive/unarchive.
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
  requireFlag,
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
  if (sub === "create") {
    const title = rest[1];
    if (!title) fail("usage: rotom group create <title> --agents <a,b[,c]> [--message M] [--note D] [--note-file F] [--cwd PATH] [--no-template]");
    const agentsFlag = requireFlag(flags, "agents");
    const agents = agentsFlag.split(",").map((s) => s.trim()).filter(Boolean);
    if (agents.length === 0) fail("--agents must list at least one agent name (comma-separated)");
    const message = flagStr(flags, "message");
    const noteInline = flagStr(flags, "note");
    const noteFile = flagStr(flags, "note-file");
    if (noteInline && noteFile) fail("--note and --note-file are mutually exclusive");
    const cwd = flagStr(flags, "cwd");
    const noTemplate = flags["no-template"] === true;

    // 预检:校验 --agents 名字都已注册,未注册 → fail 不建群
    const allAgents = await api(agent, "GET", "/agents") as any[];
    const knownNames = new Set(allAgents.map((a) => a.name));
    const unknown = agents.filter((n) => !knownNames.has(n));
    if (unknown.length > 0) {
      fail(
        `--agents contains unregistered name(s): ${unknown.join(", ")}\n` +
        `  注册过的 agent 见 \`rotom directory\`。建群中止,未产生任何副作用。`,
      );
    }

    // 建群 + 拉人(一次 API 调用,master 内部 addGroupMembers)
    const createBody: Record<string, unknown> = { name: title, memberNames: agents };
    if (cwd) createBody.workingDir = cwd;
    const created = await api(agent, "POST", "/groups", createBody) as { id: string; name: string; working_dir: string };
    const groupId = created.id;

    // 默认加载"群内讨论方案设计" guidance template
    let guidanceTemplate: string | null = null;
    if (!noTemplate) {
      try {
        const templates = await api(agent, "GET", "/guidance-templates") as any[];
        const tpl = templates.find((t) => t.name === "群内讨论方案设计");
        if (tpl?.prompt_text) {
          await api(agent, "PATCH", `/groups/${encodeURIComponent(groupId)}`, { guidancePrompt: tpl.prompt_text });
          guidanceTemplate = tpl.name;
        } else {
          process.stderr.write(`[rotom] warn: guidance template "群内讨论方案设计" not found on master, skip (group still created)\n`);
        }
      } catch (e) {
        process.stderr.write(`[rotom] warn: failed to load guidance template: ${(e as Error).message} (group still created)\n`);
      }
    }

    // 可选:建群即发开场消息
    let messagePosted = false;
    if (message) {
      await api(agent, "POST", `/cli/groups/${encodeURIComponent(groupId)}/send`, { target: "全体", message });
      messagePosted = true;
    }

    // 可选:建群即建 note
    let noteId: string | undefined;
    if (noteInline || noteFile) {
      let noteDescription = "";
      if (noteFile) {
        const expanded = noteFile.startsWith("~/") ? path.join(process.env.HOME || "", noteFile.slice(2)) : noteFile;
        if (!fs.existsSync(expanded)) fail(`--note-file not found: ${expanded}`);
        noteDescription = fs.readFileSync(expanded, "utf-8");
      } else if (noteInline) {
        noteDescription = noteInline;
      }
      const noteRes = await api(agent, "POST", `/groups/${encodeURIComponent(groupId)}/notes`, {
        title, description: noteDescription, createdBy: agent.name,
      }) as { id?: string };
      noteId = noteRes?.id;
    }

    printJson({
      id: groupId,
      name: created.name,
      working_dir: created.working_dir,
      memberCount: agents.length,
      guidanceTemplate,
      messagePosted,
      noteId,
      hint: `验证: rotom group members ${groupId}   |   rotom group history ${groupId} --limit 20`,
    });
    return;
  }
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
  if (sub === "new-messages") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group new-messages <groupId> --since <ISO> [--content-len N] [--no-clean]");
    const since = flagStr(flags, "since");
    if (!since) fail("--since is required (北京时间字符串如 \"2026-06-30 18:02:04\" 或 UTC ISO)");
    const contentLen = flagInt(flags, "content-len") ?? 200;
    const clean = flags["clean"] !== false;
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}/messages?since=${encodeURIComponent(since)}`);
    printTable(
      data.map((m: any) => {
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
    if (!groupId || !target || !message) fail("usage: rotom group send <groupId> <target> <message...> [--no-dispatch] [--need-reply]");
    const body: Record<string, unknown> = { target, message };
    if (flags["no-dispatch"] === true) body.noDispatch = true;
    if (flags["need-reply"] === true) body.needReply = true;
    const data = await api(agent, "POST", `/cli/groups/${encodeURIComponent(groupId)}/send`, body);
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
