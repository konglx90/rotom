/**
 * rotom team — Federation 团队 CLI(不依赖 dashboard)。
 *
 * 通过本机 master 的 REST API 操作 federation 状态:
 *   rotom team join <coordEndpoint> [--team-name <name>]
 *   rotom team leave
 *   rotom team list
 *   rotom team members [--team-id <id>]
 *
 * 不需要 agent 上下文(不带 token),走 masterFetch。
 * 本机 master 必须先起来;若未起,fail 给清晰提示。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROTOM_HOME,
  fail,
  flagStr,
  printJson,
} from "./common.js";
import { masterFetch, route } from "./routes.js";
import { resolveLocalMasterUrl } from "./identity.js";

async function probeLocalMaster(httpBase: string): Promise<void> {
  const probe = await masterFetch(`${httpBase}/api/identity`, { method: "GET" }).catch(() => null);
  if (!probe || probe.status === 0) {
    fail(
      `local master unreachable at ${httpBase}. ` +
      `Start it first (e.g. \`rotom master start --daemon\` or \`rotom run opc\`).`,
    );
  }
  if (probe.status >= 500) {
    fail(`local master returned HTTP ${probe.status}: ${JSON.stringify(probe.data)}`);
  }
}

/** 从 ~/.rotom/team.json 读当前 teamId(member 模式) */
function readLocalTeamId(): string {
  const teamConfigPath = path.join(ROTOM_HOME, "team.json");
  try {
    const raw = JSON.parse(fs.readFileSync(teamConfigPath, "utf-8"));
    if (raw?.id) return raw.id as string;
  } catch { /* not joined yet */ }
  fail(
    `no ~/.rotom/team.json found — run \`rotom team join <coordEndpoint>\` first, ` +
    `or pass --team-id explicitly.`,
  );
}

export async function cmdTeam(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (!sub) {
    fail(
      "usage: rotom team <join|leave|list|members> [args]\n" +
      "  join <coordEndpoint> [--team-name N]\n" +
      "  leave\n" +
      "  list\n" +
      "  members [--team-id ID]",
    );
  }

  const httpBase = resolveLocalMasterUrl();
  await probeLocalMaster(httpBase);
  const args = rest.slice(1);

  switch (sub) {
    case "join":   return cmdTeamJoin(httpBase, args, flags);
    case "leave":  return cmdTeamLeave(httpBase);
    case "list":   return cmdTeamList(httpBase);
    case "members": return cmdTeamMembers(httpBase, args, flags);
    default:
      fail(`unknown team subcommand: ${sub}\nRun 'rotom team' for usage.`);
  }
}

async function cmdTeamJoin(httpBase: string, args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const coordEndpoint = args[0];
  if (!coordEndpoint) {
    fail("usage: rotom team join <coordEndpoint> [--team-name <name>]\n  coordEndpoint e.g. ws://192.168.1.5:28800");
  }
  const teamName = flagStr(flags, "team-name");
  const body: Record<string, string> = { coordEndpoint };
  if (teamName) body.teamName = teamName;

  const resp = await masterFetch(`${httpBase}/api/teams/join`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (resp.status < 200 || resp.status >= 300) {
    const err = (resp.data as any)?.error ?? JSON.stringify(resp.data);
    fail(`team join failed (HTTP ${resp.status}): ${err}`);
  }
  printJson(resp.data);
}

async function cmdTeamLeave(httpBase: string): Promise<void> {
  const resp = await masterFetch(`${httpBase}/api/teams/leave`, { method: "POST" });
  if (resp.status < 200 || resp.status >= 300) {
    const err = (resp.data as any)?.error ?? JSON.stringify(resp.data);
    fail(`team leave failed (HTTP ${resp.status}): ${err}`);
  }
  printJson(resp.data);
}

async function cmdTeamList(httpBase: string): Promise<void> {
  const resp = await masterFetch(`${httpBase}/api/teams`, { method: "GET" });
  if (resp.status < 200 || resp.status >= 300) {
    const err = (resp.data as any)?.error ?? JSON.stringify(resp.data);
    fail(`team list failed (HTTP ${resp.status}): ${err}`);
  }
  printJson(resp.data);
}

async function cmdTeamMembers(httpBase: string, args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const teamIdFlag = flagStr(flags, "team-id");
  const teamId = teamIdFlag ?? readLocalTeamId();
  const url = `${httpBase}${route("/api/teams/:id/members", teamId)}`;
  const resp = await masterFetch(url, { method: "GET" });
  if (resp.status < 200 || resp.status >= 300) {
    const err = (resp.data as any)?.error ?? JSON.stringify(resp.data);
    fail(`team members failed (HTTP ${resp.status}): ${err}`);
  }
  printJson(resp.data);
}
