/**
 * rotom memory — 记忆管理子命令。
 *
 * agent_memory 表的 CLI。note(agent_visible=0)用 `--type note` 查询/创建;
 * memory(agent_visible=1)是默认。旧 `rotom note` 命令保留兼容,转调本模块。
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  flagInt,
  requireFlag,
} from "./common.js";

const CATEGORIES = ["fact", "decision", "convention", "pitfall", "todo", "playbook", "note"] as const;

function parseTags(flags: Record<string, string | boolean>): string[] | undefined {
  const v = flagStr(flags, "tags");
  if (!v) return undefined;
  if (v.startsWith("[")) {
    try { return JSON.parse(v); } catch { fail(`--tags invalid JSON array: ${v}`); }
  }
  return v.split(",").map(t => t.trim()).filter(Boolean);
}

function fmtPreview(s: string | null | undefined, len = 60): string {
  if (!s) return "";
  const flat = s.replace(/\n/g, " ");
  return flat.length > len ? flat.slice(0, len) + "…" : flat;
}

export async function cmdMemory(
  agent: ResolvedAgent,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const sub = rest[0];
  const scope = flagStr(flags, "scope") === "global" ? "global" : "group";

  // ── search ───────────────────────────────────────────────────────────
  if (sub === "search") {
    const keyword = rest[1];
    if (!keyword) fail("usage: rotom memory search <keyword> [--scope group|global] [groupId] [--category <c>]");
    const category = flagStr(flags, "category");
    const limit = flagInt(flags, "limit") ?? 20;
    let url: string;
    if (scope === "global") {
      url = `/memory/search?q=${encodeURIComponent(keyword)}&limit=${limit}`;
      if (category) url += `&category=${category}`;
    } else {
      const groupId = rest[2];
      if (!groupId) fail("usage: rotom memory search <keyword> <groupId> (group scope needs groupId)");
      url = `/groups/${encodeURIComponent(groupId)}/memory/search?q=${encodeURIComponent(keyword)}&limit=${limit}`;
      if (category) url += `&category=${category}`;
    }
    const data = await api(agent, "GET", url);
    // group search 返回 {group, global}; global search 返回数组
    const rows = Array.isArray(data) ? data : [...(data.group || []), ...(data.global || [])];
    printTable(
      rows.map((m: any) => ({
        id: m.id,
        scope: m.scope,
        category: m.category,
        key: m.key,
        summary: fmtPreview(m.summary, 50),
        by: m.created_by ?? "",
      })),
      ["id", "scope", "category", "key", "summary", "by"],
    );
    return;
  }

  // ── list ─────────────────────────────────────────────────────────────
  if (sub === "list") {
    const type = flagStr(flags, "type");
    const category = flagStr(flags, "category");
    const tags = parseTags(flags);
    const includePending = flags["include-pending"] === true || flags["include-pending"] === "true";
    let url: string;
    if (scope === "global") {
      url = `/memory/global?`;
    } else {
      const groupId = rest[1];
      if (!groupId) fail("usage: rotom memory list <groupId> [--scope group|global] [--type note|memory|all]");
      url = `/groups/${encodeURIComponent(groupId)}/memory?`;
    }
    const qs: string[] = [];
    if (type && type !== "all") qs.push(`type=${type}`);
    if (category) qs.push(`category=${category}`);
    if (tags && tags.length) qs.push(`tags=${encodeURIComponent(tags.join(","))}`);
    if (includePending) qs.push(`includePending=true`);
    url += qs.join("&");
    const data = await api(agent, "GET", url);
    printTable(
      data.map((m: any) => ({
        id: m.id.slice(0, 8),
        cat: m.category,
        av: m.agent_visible ? "M" : "N",  // M=memory N=note
        key: m.key,
        summary: fmtPreview(m.summary, 50),
        by: m.created_by ?? "",
        viewed: "",
      })),
      ["id", "cat", "av", "key", "summary", "by"],
    );
    return;
  }

  // ── get ──────────────────────────────────────────────────────────────
  if (sub === "get") {
    const id = rest[1];
    if (!id) fail("usage: rotom memory get <memoryId>");
    const data = await api(agent, "GET", `/memory/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }

  // ── add ──────────────────────────────────────────────────────────────
  if (sub === "add") {
    const key = requireFlag(flags, "key");
    const value = requireFlag(flags, "value");
    const category = flagStr(flags, "category");
    if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
      fail(`--category required, one of: ${CATEGORIES.join(", ")}`);
    }
    const summary = flagStr(flags, "summary");
    const tags = parseTags(flags) ?? [];
    const visibility = flagStr(flags, "visibility");
    // parseArgs: --no-agent-visible → flags["agent-visible"]=false;--agent-visible → true
    const agentVisible = flags["agent-visible"] !== false;
    const pendingReview = flags["pending"] === true;
    const expiresAt = flagStr(flags, "expires");
    const createdBy = flagStr(flags, "created-by") ?? agent.name;

    let url: string;
    let body: Record<string, unknown> = {
      key, value, category, tags,
      agentVisible,
      createdBy,
    };
    if (summary) body.summary = summary;
    if (visibility) body.visibility = visibility;
    if (expiresAt) body.expiresAt = expiresAt;
    if (pendingReview) body.pendingReview = true;

    if (scope === "global") {
      url = `/memory/global`;
    } else {
      const groupId = rest[1];
      if (!groupId) fail("usage: rotom memory add <groupId> --key K --value V --category C [--scope global]");
      url = `/groups/${encodeURIComponent(groupId)}/memory`;
    }
    const data = await api(agent, "POST", url, body);
    printJson(data);
    return;
  }

  // ── update ────────────────────────────────────────────────────────────
  if (sub === "update") {
    const id = rest[1];
    if (!id) fail("usage: rotom memory update <memoryId> [--value V] [--summary S] [--tags t1,t2] [--category C] [--visibility V] [--agent-visible|--no-agent-visible]");
    const body: Record<string, unknown> = {};
    const value = flagStr(flags, "value");
    const summary = flagStr(flags, "summary");
    const tags = parseTags(flags);
    const category = flagStr(flags, "category");
    const visibility = flagStr(flags, "visibility");
    if (value !== undefined) body.value = value;
    if (summary !== undefined) body.summary = summary;
    if (tags !== undefined) body.tags = tags;
    if (category) {
      if (!(CATEGORIES as readonly string[]).includes(category)) fail(`--category one of: ${CATEGORIES.join(", ")}`);
      body.category = category;
    }
    if (visibility) body.visibility = visibility;
    if (flags["agent-visible"] === true) body.agentVisible = true;
    if (flags["agent-visible"] === false) body.agentVisible = false;
    if (Object.keys(body).length === 0) fail("no fields to update");
    await api(agent, "PATCH", `/memory/${encodeURIComponent(id)}`, body);
    printJson({ ok: true });
    return;
  }

  // ── remove / expire / promote ────────────────────────────────────────
  if (sub === "remove") {
    const id = rest[1]; if (!id) fail("usage: rotom memory remove <memoryId>");
    await api(agent, "DELETE", `/memory/${encodeURIComponent(id)}`);
    printJson({ ok: true });
    return;
  }
  if (sub === "expire") {
    const id = rest[1]; if (!id) fail("usage: rotom memory expire <memoryId>");
    await api(agent, "POST", `/memory/${encodeURIComponent(id)}/expire`);
    printJson({ ok: true });
    return;
  }
  if (sub === "promote") {
    const id = rest[1]; if (!id) fail("usage: rotom memory promote <memoryId> --visibility global");
    const visibility = flagStr(flags, "visibility");
    if (visibility !== "global" && visibility !== "private" && visibility !== "group") {
      fail("--visibility required: global | private | group");
    }
    await api(agent, "POST", `/memory/${encodeURIComponent(id)}/promote`, { visibility });
    printJson({ ok: true });
    return;
  }

  // ── promote-to-skill(playbook memory → 全局 skill)────────────────────
  if (sub === "promote-to-skill") {
    const id = rest[1]; if (!id) fail("usage: rotom memory promote-to-skill <memoryId> [--name N] [--description D]");
    const name = flagStr(flags, "name");
    const description = flagStr(flags, "description");
    const body: Record<string, unknown> = { createdBy: agent.name };
    if (name) body.name = name;
    if (description) body.description = description;
    const data = await api(agent, "POST", `/memory/${encodeURIComponent(id)}/promote-to-skill`, body);
    printJson(data);
    return;
  }

  // ── 审核 ──────────────────────────────────────────────────────────────
  if (sub === "pending") {
    let url: string;
    if (scope === "global") {
      url = `/memory/pending?scope=global`;
    } else {
      const groupId = rest[1];
      if (!groupId) fail("usage: rotom memory pending <groupId> [--scope global]");
      url = `/groups/${encodeURIComponent(groupId)}/memory/pending`;
    }
    const data = await api(agent, "GET", url);
    printTable(
      data.map((m: any) => ({
        id: m.id.slice(0, 8),
        cat: m.category,
        key: m.key,
        summary: fmtPreview(m.summary, 50),
        by: m.created_by ?? "",
      })),
      ["id", "cat", "key", "summary", "by"],
    );
    return;
  }
  if (sub === "approve") {
    const id = rest[1]; if (!id) fail("usage: rotom memory approve <memoryId>");
    await api(agent, "POST", `/memory/${encodeURIComponent(id)}/approve`);
    printJson({ ok: true });
    return;
  }
  if (sub === "reject") {
    const id = rest[1]; if (!id) fail("usage: rotom memory reject <memoryId>");
    await api(agent, "POST", `/memory/${encodeURIComponent(id)}/reject`);
    printJson({ ok: true });
    return;
  }

  // ── stats ────────────────────────────────────────────────────────────
  if (sub === "stats") {
    let url: string;
    if (scope === "global") {
      url = `/memory/stats?scope=global`;
    } else {
      const groupId = rest[1];
      if (!groupId) fail("usage: rotom memory stats <groupId> [--scope global] [--stale]");
      url = `/groups/${encodeURIComponent(groupId)}/memory/stats`;
    }
    const data = await api(agent, "GET", url);
    printJson(data);

    if (flags["stale"] === true || flags["stale"] === "true") {
      const minAge = flagInt(flags, "min-age") ?? 30;
      // listMemory 不直接支持 stale,这里复用 stats 拿到的 topViewed 反推不够,
      // 改用 list 接口 + 客户端过滤太重。直接走专用接口更合适,但未实现。
      // 留作 TODO:加 /memory/stale 端点。当前用 stats 的 topViewed 近似。
      console.error(`(stale 列表需 /memory/stale 端点,当前未实现;min-age=${minAge})`);
    }
    return;
  }

  fail(`unknown memory subcommand: ${sub || "(none)"}
usage:
  memory search <keyword> <groupId> [--scope group|global] [--category <c>]
  memory list <groupId> [--scope group|global] [--type note|memory|all] [--category <c>] [--tags t1,t2]
  memory get <memoryId>
  memory add <groupId> --key K --value V --category C [--scope global] [--summary S] [--tags t1,t2]
                   [--visibility group|global|private] [--no-agent-visible] [--pending] [--expires 7d]
  memory update <id> [--value V] [--summary S] [--tags t1,t2] [--category C] [--visibility V] [--agent-visible|--no-agent-visible]
  memory remove <id>
  memory expire <id>
  memory promote <id> --visibility global
  memory promote-to-skill <memoryId> [--name N] [--description D]   # playbook → 全局 skill
  memory pending <groupId> [--scope global]
  memory approve <id>
  memory reject <id>
  memory stats <groupId> [--scope global]`);
}
