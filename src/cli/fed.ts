/**
 * rotom fed — 跨机联邦查询 CLI(走本机 rotom-link daemon)。
 *
 *   rotom fed members                列出可见 agent(从协调 master 同步来的目录)
 *
 * 跨机点对点提问用 `rotom ask <name@hostname> "<q>"`,见 src/cli/ask.ts。
 *
 * `<ref>` 形如 "alice@hostB" 或 "alice"(后者依赖团队内 name 唯一)。
 * 走本机 link daemon 的 http://127.0.0.1:28900。
 */

import { fail, flagStr, printJson, extractApiError } from "./common.js";
import { masterFetch } from "./routes.js";

const DEFAULT_LINK_PORT = 28900;

function linkHttpBase(flags: Record<string, string | boolean>): string {
  const port = flagStr(flags, "port") ?? String(DEFAULT_LINK_PORT);
  return `http://127.0.0.1:${port}`;
}

async function probeLink(httpBase: string): Promise<void> {
  const probe = await masterFetch(`${httpBase}/health`, { method: "GET" }).catch(() => null);
  if (!probe || probe.status === 0) {
    fail(
      `rotom-link daemon unreachable at ${httpBase}. ` +
      `Start it first: \`rotom link start\` (after \`rotom link join <coordEndpoint> --hostname <name>\`).`,
    );
  }
}

export async function cmdFed(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (!sub) {
    fail(
      "usage: rotom fed <members> [args]\n" +
      "  members                              列出可见 agent (协调 master 同步目录)\n" +
      "\n" +
      "跨机点对点提问用 `rotom ask <name@hostname> \"<q>\"` (见 rotom ask --help)",
    );
  }
  const httpBase = linkHttpBase(flags);
  await probeLink(httpBase);

  switch (sub) {
    case "members": return cmdFedMembers(httpBase);
    default: fail(`unknown fed subcommand: ${sub}\nRun 'rotom fed' for usage.`);
  }
}

async function cmdFedMembers(httpBase: string): Promise<void> {
  const resp = await masterFetch(`${httpBase}/fed/directory`, { method: "GET" });
  if (resp.status < 200 || resp.status >= 300) {
    const err = extractApiError(resp.data);
    fail(`fed members failed (HTTP ${resp.status}): ${err}`);
  }
  printJson(resp.data);
}
