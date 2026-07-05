/**
 * rotom fed — 跨机对话 CLI(走本机 rotom-link daemon)。
 *
 *   rotom fed members                列出可见 agent(从协调 master 同步来的目录)
 *   rotom fed ask <ref> "<question>"  阻塞等回复(--timeout 5m,对齐 src/cli/ask.ts)
 *
 * `<ref>` 形如 "alice@hostB" 或 "alice"(后者依赖团队内 name 唯一)。
 * 走本机 link daemon 的 http://127.0.0.1:28900。
 */

import { fail, flagStr, printJson } from "./common.js";
import { masterFetch } from "./routes.js";
import { parseAgentRef } from "../shared/protocol/federation.js";

const DEFAULT_LINK_PORT = 28900;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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
      "usage: rotom fed <members|ask> [args]\n" +
      "  members                              列出可见 agent (协调 master 同步目录)\n" +
      "  ask <ref> \"<question>\" [--timeout 5m]   阻塞等回复 (ref 形如 alice@hostB 或 alice)",
    );
  }
  const httpBase = linkHttpBase(flags);
  await probeLink(httpBase);
  const args = rest.slice(1);

  switch (sub) {
    case "members": return cmdFedMembers(httpBase);
    case "ask":    return cmdFedAsk(httpBase, args, flags);
    default: fail(`unknown fed subcommand: ${sub}\nRun 'rotom fed' for usage.`);
  }
}

async function cmdFedMembers(httpBase: string): Promise<void> {
  const resp = await masterFetch(`${httpBase}/fed/directory`, { method: "GET" });
  if (resp.status < 200 || resp.status >= 300) {
    const err = (resp.data as any)?.error ?? JSON.stringify(resp.data);
    fail(`fed members failed (HTTP ${resp.status}): ${err}`);
  }
  printJson(resp.data);
}

async function cmdFedAsk(httpBase: string, args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const ref = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!ref) {
    fail("usage: rotom fed ask <ref> \"<question>\"\n  ref e.g. alice@hostB 或 alice(团队内 name 唯一)");
  }
  if (!message) {
    fail(`question is empty (got: ${args.slice(1).join(" ")})`);
  }
  // 校验 ref 形式:不带 @ 的裸 name 也接受,link daemon 会依赖团队内唯一性
  const parsed = parseAgentRef(ref);
  if (!parsed.hostname) {
    process.stderr.write(`[rotom-fed] warning: "${ref}" 不带 @hostname,link daemon 会按团队内 name 唯一性路由\n`);
  }

  const timeoutStr = flagStr(flags, "timeout");
  const timeoutMs = timeoutStr ? parseDurationMs(timeoutStr) : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await masterFetch(`${httpBase}/fed/ask`, {
      method: "POST",
      body: JSON.stringify({ to: ref, message }),
      signal: controller.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const err = (resp.data as any)?.error ?? JSON.stringify(resp.data);
      fail(`fed ask failed (HTTP ${resp.status}): ${err}`);
    }
    printJson(resp.data);
  } finally {
    clearTimeout(timer);
  }
}

function parseDurationMs(s: string): number {
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m) fail(`invalid --timeout: ${s} (e.g. 30s / 5m / 1h)`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}
