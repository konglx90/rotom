/**
 * rotom skill — 全局 skill 知识库 + (group, agent, skill) 绑定关系管理。
 *
 * skill 是全局能力资产,本身无可见性。可见性靠绑定:某群的某 agent 持有某 skill。
 * `rotom skill mine <groupId>` 查当前 agent 在该群绑定的 skill。
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  requireFlag,
} from "./common.js";
import { route, qs, usage } from "./routes.js";
import { readFileSync } from "node:fs";

function fmtPreview(s: string, len = 60): string {
  if (!s) return "";
  const flat = s.replace(/\n/g, " ");
  return flat.length > len ? flat.slice(0, len) + "…" : flat;
}

/** --content 'foo' 或 --content @path/to/file.md。 */
function resolveContent(v: string): string {
  if (v.startsWith("@")) {
    try { return readFileSync(v.slice(1), "utf-8"); }
    catch (e) { fail(`读取 --content ${v} 失败:${(e as Error).message}`); }
  }
  return v;
}

export async function cmdSkill(
  agent: ResolvedAgent,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const sub = rest[0];

  // ── list(全局 skill 索引)─────────────────────────────────────────────
  if (sub === "list") {
    const category = flagStr(flags, "category");
    const url = `${route("/skills")}${qs({ category })}`;
    const data = await api(agent, "GET", url);
    printTable(
      data.map((s: any) => ({
        name: s.name,
        category: s.category ?? "",
        description: fmtPreview(s.description, 50),
        views: s.view_count,
      })),
      ["name", "category", "description", "views"],
    );
    return;
  }

  // ── search ───────────────────────────────────────────────────────────
  if (sub === "search") {
    const keyword = rest[1];
    if (!keyword) usage("skill search", "<keyword>");
    const data = await api(agent, "GET", `${route("/skills/search")}${qs({ q: keyword })}`);
    printTable(
      data.map((s: any) => ({
        name: s.name,
        category: s.category ?? "",
        description: fmtPreview(s.description, 50),
      })),
      ["name", "category", "description"],
    );
    return;
  }

  // ── get(看全文,view_count+1)─────────────────────────────────────────
  if (sub === "get") {
    const name = rest[1];
    if (!name) usage("skill get", "<name>");
    const data = await api(agent, "GET", route("/skills/:name", name));
    printJson(data);
    return;
  }

  // ── create ───────────────────────────────────────────────────────────
  if (sub === "create") {
    const name = requireFlag(flags, "name");
    const description = requireFlag(flags, "description");
    const contentRaw = requireFlag(flags, "content");
    const content = resolveContent(contentRaw);
    const category = flagStr(flags, "category");
    if (!name || !description || !content) fail("--name, --description, --content 都必填");
    const body: Record<string, unknown> = { name: name.trim(), description, content, createdBy: agent.name };
    if (category) body.category = category;
    const data = await api(agent, "POST", "/skills", body);
    printJson(data);
    return;
  }

  // ── update ───────────────────────────────────────────────────────────
  if (sub === "update") {
    const name = rest[1];
    if (!name) usage("skill update", "<name> [--description D] [--content C|@file] [--category C]");
    const body: Record<string, unknown> = {};
    const description = flagStr(flags, "description");
    const contentRaw = flagStr(flags, "content");
    const category = flagStr(flags, "category");
    if (description !== undefined) body.description = description;
    if (contentRaw !== undefined) body.content = resolveContent(contentRaw);
    if (category !== undefined) body.category = category;
    if (Object.keys(body).length === 0) fail("至少传一个 --description / --content / --category");
    await api(agent, "PATCH", route("/skills/:name", name), body);
    printJson({ ok: true });
    return;
  }

  // ── remove ──────────────────────────────────────────────────────────
  if (sub === "remove") {
    const name = rest[1];
    if (!name) usage("skill remove", "<name>");
    await api(agent, "DELETE", route("/skills/:name", name));
    printJson({ ok: true });
    return;
  }

  // ── bind / unbind ───────────────────────────────────────────────────
  if (sub === "bind") {
    const groupId = rest[1];
    const agentName = rest[2];
    const skillName = rest[3];
    if (!groupId || !agentName || !skillName) usage("skill bind", "<groupId> <agentName> <skillName>");
    await api(agent, "POST", route("/groups/:groupId/skills/:agent/bind", groupId, agentName), {
      skillName,
    });
    printJson({ ok: true });
    return;
  }
  if (sub === "unbind") {
    const groupId = rest[1];
    const agentName = rest[2];
    const skillName = rest[3];
    if (!groupId || !agentName || !skillName) usage("skill unbind", "<groupId> <agentName> <skillName>");
    await api(agent, "DELETE", route("/groups/:groupId/skills/:agent/bind/:skill", groupId, agentName, skillName));
    printJson({ ok: true });
    return;
  }

  // ── bindings(查绑定关系)───────────────────────────────────────────
  if (sub === "bindings") {
    const groupId = rest[1];
    const agentName = rest[2];
    const url = `${route("/skills/bindings/all")}${qs({ groupId, agentName })}`;
    const data = await api(agent, "GET", url);
    printTable(
      data.map((b: any) => ({
        group: b.group_id?.slice(0, 8) ?? "",
        agent: b.agent_name,
        skill: b.skill_name ?? b.skill_id?.slice(0, 8) ?? "",
      })),
      ["group", "agent", "skill"],
    );
    return;
  }

  // ── reconcile(文件 ↔ DB 双向收敛;boot 时已自动跑一次,这里手动触发)─
  if (sub === "reconcile") {
    const data = await api(agent, "POST", route("/skills/reconcile"));
    printJson(data);
    return;
  }

  // ── mine(当前 agent 在该群绑定的 skill)────────────────────────────
  if (sub === "mine") {
    const groupId = rest[1];
    if (!groupId) usage("skill mine", "<groupId>");
    const data = await api(agent, "GET", route("/groups/:groupId/skills/:agent", groupId, agent.name));
    printTable(
      data.map((s: any) => ({
        name: s.name,
        category: s.category ?? "",
        description: fmtPreview(s.description, 50),
      })),
      ["name", "category", "description"],
    );
    return;
  }

  fail(`unknown skill subcommand: ${sub || "(none)"}
usage:
  skill list [--category <c>]
  skill search <keyword>
  skill get <name>
  skill create --name <n> --description <d> --content <c|@file> [--category <c>]
  skill update <name> [--description <d>] [--content <c|@file>] [--category <c>]
  skill remove <name>
  skill reconcile                     # 文件 ↔ DB 双向收敛(手动触发)
  skill bind <groupId> <agentName> <skillName>
  skill unbind <groupId> <agentName> <skillName>
  skill bindings [groupId] [agentName]
  skill mine <groupId>                # 当前 agent 在该群绑定的 skill
`);
}
