import { toBeijing } from "../shared/time.js";
/**
 * rotom ask —— 点对点提问的唯一入口。
 *
 *   rotom ask <target> "<question>" [--mode sync|async] [--timeout 5m] [--escalate-to <真人>]
 *     target 形如 "alice"(本地)或 "alice@hostname"(联邦,走 link daemon)
 *     sync(默认):阻塞等回复,5min 超时 exit 2(不升级 Issue)
 *     async:发完即返 bridgeId,5min 超时升级 Issue 给 asker
 *
 *   rotom ask list --group <id> [--status pending|answered|timed_out|cancelled]
 *   rotom ask show <bridgeId>
 *   rotom ask cancel <bridgeId>
 *
 * 群永远建在协调 master 上(本地场景本机即协调,联邦场景显式协调 master)。
 * a2a_direct pair 群 3 天 TTL 续命/过期(由 master 端 scheduler 扫)。
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  pretty,
} from "./common.js";
import { route, qs, usage } from "./routes.js";
import { parseAgentRef } from "../shared/protocol/federation.js";

function formatBridgeRow(b: any) {
  return {
    id: b.id.slice(0, 8),
    group: b.group_id.slice(0, 8),
    asker: b.asker,
    target: b.target,
    mode: b.mode ?? "async",
    status: b.status,
    escalate_to: b.escalate_to || "-",
    created: b.created_at ? toBeijing(b.created_at).slice(11, 19) : "-",
    expires: b.expires_at ? toBeijing(b.expires_at).slice(11, 19) : "-",
    reply_msg: b.reply_msg_id ?? "-",
    issue: b.issue_id ? b.issue_id.slice(0, 8) : "-",
  };
}

function parseDurationMs(s: string): number {
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m) fail(`invalid --timeout: ${s} (e.g. 30s / 5m / 1h)`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

const DEFAULT_LINK_PORT = 28900;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function linkHttpBase(flags: Record<string, string | boolean>): string {
  const port = flagStr(flags, "port") ?? String(DEFAULT_LINK_PORT);
  return `http://127.0.0.1:${port}`;
}

async function probeLink(httpBase: string): Promise<void> {
  const probe = await fetch(`${httpBase}/health`, { method: "GET" }).catch(() => null);
  if (!probe || probe.status === 0) {
    fail(
      `rotom-link daemon unreachable at ${httpBase}. ` +
      `Start it first: \`rotom link start\` (after \`rotom link join <coordEndpoint> --hostname <name>\`).`,
    );
  }
}

async function askFederated(
  agent: ResolvedAgent,
  target: string,
  parsed: { name: string; hostname?: string },
  question: string,
  mode: "sync" | "async",
  timeoutMs: number,
  escalateTo: string | null,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (mode === "async") {
    fail("联邦路径暂只支持 sync 模式(协调 master 的 bridge 是同步阻塞模型)。本地 async 用 `rotom ask <name> \"<q>\" --mode async`。");
  }
  const httpBase = linkHttpBase(flags);
  await probeLink(httpBase);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${httpBase}/fed/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: target,
        message: question,
        from: agent.name,
        mode,
        timeoutMs,
        escalateTo,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({} as any));
      const err = (errBody as any)?.error ?? `${resp.status} ${resp.statusText}`;
      fail(`fed ask failed (HTTP ${resp.status}): ${err}`);
    }
    const data = await resp.json() as { ok: boolean; reply?: string; requestId?: string; error?: string };
    if (!data.ok) {
      fail(`fed ask failed: ${data.error ?? "unknown"}`);
    }
    printJson({ ok: true, reply: data.reply, requestId: data.requestId, target: `${parsed.name}@${parsed.hostname}` });
  } finally {
    clearTimeout(timer);
  }
}

async function askLocal(
  agent: ResolvedAgent,
  target: string,
  question: string,
  mode: "sync" | "async",
  timeoutMs: number,
  escalateTo: string | null,
): Promise<void> {
  const body: Record<string, unknown> = { target, message: question, mode, timeoutMs, asker: agent.name };
  if (escalateTo) body.escalateTo = escalateTo;
  const data = await api(agent, "POST", "/asks", body) as any;
  if (data.ok && mode === "sync" && data.status === "answered") {
    printJson({ ok: true, bridgeId: data.bridgeId, reply: data.reply, target });
    return;
  }
  if (data.ok && mode === "async") {
    printJson({ ok: true, bridgeId: data.bridgeId, groupId: data.groupId, status: data.status, target });
    return;
  }
  // sync 超时
  if (!data.ok && data.status === "timed_out") {
    printJson({ ok: false, bridgeId: data.bridgeId, status: "timed_out", target });
    process.exit(2);
  }
  if (!data.ok) {
    printJson({ ok: false, status: data.status, error: data.error, target });
    process.exit(1);
  }
  printJson(data);
}

export async function cmdAsk(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];

  if (sub === "list") {
    const gid = flagStr(flags, "group");
    const status = flagStr(flags, "status");
    if (!gid) usage("ask list", "--group <id> [--status pending|answered|timed_out|cancelled]");
    const data = await api(agent, "GET", `${route("/groups/:groupId/asks", gid)}${qs({ status })}`);
    if (pretty) {
      printTable((data as any[]).map(formatBridgeRow), ["id", "group", "asker", "target", "mode", "status", "escalate_to", "created", "expires", "reply_msg", "issue"]);
    } else {
      printJson(data);
    }
    return;
  }

  if (sub === "show") {
    const id = rest[1]; if (!id) usage("ask show", "<bridgeId>");
    const data = await api(agent, "GET", route("/asks/:id", id));
    printJson(data);
    return;
  }

  if (sub === "cancel") {
    const id = rest[1]; if (!id) usage("ask cancel", "<bridgeId>");
    const data = await api(agent, "POST", route("/asks/:id/cancel", id));
    printJson(data);
    return;
  }

  // 提问路径: rotom ask <target> "<question>" [--mode sync|async] [--timeout 5m] [--escalate-to <真人>]
  const target = sub;
  if (!target) {
    fail(
      "usage: rotom ask <target> \"<question>\" [--mode sync|async] [--timeout 5m] [--escalate-to <真人>]\n" +
      "  target 形如 \"alice\"(本地) 或 \"alice@hostname\"(联邦)\n" +
      "  ask list --group <id> [--status pending|answered|timed_out|cancelled]\n" +
      "  ask show <bridgeId>\n" +
      "  ask cancel <bridgeId>",
    );
  }
  const question = rest.slice(1).join(" ").trim();
  if (!question) fail(`question is empty (got: ${rest.slice(1).join(" ")})`);

  const mode: "sync" | "async" = flagStr(flags, "mode") === "async" ? "async" : "sync";
  const timeoutStr = flagStr(flags, "timeout");
  const timeoutMs = timeoutStr ? parseDurationMs(timeoutStr) : DEFAULT_TIMEOUT_MS;
  const escalateTo = flagStr(flags, "escalate-to") ?? null;

  const parsed = parseAgentRef(target);
  if (parsed.hostname) {
    await askFederated(agent, target, parsed, question, mode, timeoutMs, escalateTo, flags);
    return;
  }
  await askLocal(agent, parsed.name, question, mode, timeoutMs, escalateTo);
}
