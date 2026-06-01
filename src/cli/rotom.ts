#!/usr/bin/env node
/**
 * rotom — Mesh CLI for digital employees.
 *
 * Every invocation acts as a specific agent. Selection priority:
 *   1. ROTOM_AGENT env
 *   2. --as <name>
 *   3. ~/.rotom/config.json#defaultAgent
 * If none of those resolve, rotom refuses to run (so you never accidentally
 * use the wrong agent's token on a multi-agent box).
 *
 * The agent's master URL + mesh token come from one of:
 *   - "openclaw":  channels['a2a-gateway'].{master,token,name}  in openclaw.json
 *   - "executor":  matching `workers[].name` in executor.config.json
 *   - Auto-discovery: ~/.rotom/executor.config.json (shared with `executor`
 *     worker process). No explicit `rotom config add-executor` needed.
 *   - Env fallback: ROTOM_MASTER + ROTOM_TOKEN (set by worker child spawns).
 *
 * Output is JSON by default. `--pretty` switches to a human table where it
 * makes sense; everywhere else it pretty-prints the same JSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const ROTOM_CONFIG = path.join(ROTOM_HOME, "config.json");
const DEFAULT_EXECUTOR_CONFIG = path.join(ROTOM_HOME, "executor.config.json");

interface RotomAgentEntry {
  configPath: string;
  kind: "openclaw" | "executor";
}
interface RotomConfig {
  defaultAgent?: string;
  agents?: Record<string, RotomAgentEntry>;
}

interface ResolvedAgent {
  name: string;
  master: string;
  token: string;
  kind: "openclaw" | "executor";
  configPath: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Config / token resolution
// ───────────────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function loadRotomConfig(): RotomConfig {
  if (!fs.existsSync(ROTOM_CONFIG)) return {};
  try { return JSON.parse(fs.readFileSync(ROTOM_CONFIG, "utf-8")) as RotomConfig; }
  catch (e) { fail(`failed to parse ${ROTOM_CONFIG}: ${(e as Error).message}`); }
}

function saveRotomConfig(cfg: RotomConfig): void {
  if (!fs.existsSync(ROTOM_HOME)) fs.mkdirSync(ROTOM_HOME, { recursive: true });
  fs.writeFileSync(ROTOM_CONFIG, JSON.stringify(cfg, null, 2));
}

function resolveFromExecutorConfig(name: string, configPath: string): ResolvedAgent | null {
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const workers: any[] = Array.isArray(raw?.workers)
    ? raw.workers
    : (raw?.name ? [raw] : []);
  const w = workers.find((x) => x?.name === name);
  if (!w) return null;
  const master = w.master || raw?.master;
  if (!master || !w.token) {
    fail(`executor config ${configPath} missing master/token for "${name}"`);
  }
  return { name, master, token: w.token, kind: "executor", configPath };
}

function listExecutorWorkers(configPath: string): string[] {
  if (!fs.existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const workers: any[] = Array.isArray(raw?.workers)
      ? raw.workers
      : (raw?.name ? [raw] : []);
    return workers.map((w) => w?.name).filter(Boolean);
  } catch { return []; }
}

function resolveAgentFromEntry(name: string, entry: RotomAgentEntry): ResolvedAgent {
  const p = expandHome(entry.configPath);
  if (!fs.existsSync(p)) fail(`config not found for agent "${name}": ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));

  if (entry.kind === "openclaw") {
    const ch = raw?.channels?.["a2a-gateway"];
    if (!ch?.token || !ch?.master || !ch?.name) {
      fail(`openclaw config ${p} missing channels['a2a-gateway'].{master,token,name}`);
    }
    if (ch.name !== name) {
      fail(`agent name mismatch: rotom expects "${name}" but ${p} declares "${ch.name}"`);
    }
    return { name, master: ch.master, token: ch.token, kind: "openclaw", configPath: p };
  }

  // executor
  const resolved = resolveFromExecutorConfig(name, p);
  if (!resolved) fail(`executor config ${p} has no worker named "${name}"`);
  return resolved;
}

function resolveAgent(asFlag?: string): ResolvedAgent {
  const cfg = loadRotomConfig();
  const chosen = process.env.ROTOM_AGENT || asFlag || cfg.defaultAgent;
  console.debug(`[rotom] Resolving agent with --as=${asFlag} ROTOM_AGENT=${process.env.ROTOM_AGENT} defaultAgent=${cfg.defaultAgent}`);
  if (!chosen) {
    const known = cfg.agents ? Object.keys(cfg.agents) : [];
    const executorWorkers = listExecutorWorkers(DEFAULT_EXECUTOR_CONFIG);
    const lines: string[] = [];
    if (known.length) lines.push(`Registered agents: ${known.join(", ")}`);
    if (executorWorkers.length) lines.push(`Executor workers (${DEFAULT_EXECUTOR_CONFIG}): ${executorWorkers.join(", ")}`);
    if (lines.length === 0) {
      lines.push(
        `No agents registered yet. Either:`,
        `  - create ${DEFAULT_EXECUTOR_CONFIG} (auto-discovered), or`,
        `  - rotom config add-openclaw <name> <path-to-openclaw.json>`,
        `  - rotom config add-executor <name> <path-to-executor.config.json>`,
      );
    } else {
      lines.push(`Use: rotom --as <name> ... or rotom config use <name>`);
    }
    fail(`no agent selected (--as / ROTOM_AGENT / defaultAgent all unset)\n${lines.join("\n")}`);
  }
  const entry = cfg.agents?.[chosen];
  if (entry) return resolveAgentFromEntry(chosen, entry);

  // Auto-discover from ~/.rotom/executor.config.json (executor + CLI shared config)
  const fromExecutor = resolveFromExecutorConfig(chosen, DEFAULT_EXECUTOR_CONFIG);
  if (fromExecutor) return fromExecutor;

  // Config entry not found — try env fallback.
  // Worker spawns set ROTOM_MASTER + ROTOM_TOKEN so rotom works without
  // any config.json on disk.
  const master = process.env.ROTOM_MASTER;
  const token = process.env.ROTOM_TOKEN;
  if (master && token) {
    return { name: chosen, master, token, kind: "executor", configPath: "(env)" };
  }

  const known = cfg.agents ? Object.keys(cfg.agents).join(", ") : "(none)";
  const executorWorkers = listExecutorWorkers(DEFAULT_EXECUTOR_CONFIG);
  const hint = executorWorkers.length
    ? `\nAvailable in ${DEFAULT_EXECUTOR_CONFIG}: ${executorWorkers.join(", ")}`
    : "";
  fail(`agent "${chosen}" not registered in ${ROTOM_CONFIG}\nKnown: ${known}${hint}`);
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP
// ───────────────────────────────────────────────────────────────────────────

function masterHttpUrl(masterWsOrHttp: string): string {
  // ws://host:port → http://host:port  (HTTP API is on the same port)
  return masterWsOrHttp
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://")
    .replace(/\/+$/, "");
}

async function api(agent: ResolvedAgent, method: string, route: string, body?: unknown): Promise<any> {
  const url = `${masterHttpUrl(agent.master)}/api${route}`;
  const init: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${agent.token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) (init as any).body = JSON.stringify(body);
  let resp: Response;
  try { resp = await fetch(url, init); }
  catch (e) { fail(`network error calling ${url}: ${(e as Error).message}`); }
  const text = await resp.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const detail = typeof data === "object" && data?.error ? data.error : text;
    fail(`HTTP ${resp.status} ${method} ${route}: ${detail}`);
  }
  return data;
}

// ───────────────────────────────────────────────────────────────────────────
// Output
// ───────────────────────────────────────────────────────────────────────────

let pretty = false;

function printJson(data: any): void {
  process.stdout.write(JSON.stringify(data, null, pretty ? 2 : 0) + "\n");
}

function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (!pretty || !rows?.length) { printJson(rows); return; }
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const sep = cols.map((_, i) => "─".repeat(widths[i])).join("─┼─");
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(" │ ");
  process.stdout.write(header + "\n" + sep + "\n");
  for (const r of rows) {
    process.stdout.write(cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join(" │ ") + "\n");
  }
}

function fail(msg: string): never {
  process.stderr.write(`rotom: ${msg}\n`);
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────
// Arg parsing — minimal, no external deps
// ───────────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v) fail(`--${name} is required`);
  return v;
}

function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function flagInt(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flagStr(flags, name);
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// Commands
// ───────────────────────────────────────────────────────────────────────────

const HELP = `rotom — Mesh CLI

Usage: rotom [--as <agent>] [--pretty] <command> [args]

Agent selection:
  --as <name>           override which registered agent to act as
  ROTOM_AGENT env       same, via env (takes priority over --as)
  defaultAgent (config) fallback
  Auto-discovery: workers in ~/.rotom/executor.config.json resolve
  by name without needing 'rotom config add-executor' first.

Config:
  config show
  config init
  config use <name>                            set default agent
  config add-openclaw <name> <openclaw.json>   register an OpenClaw-hosted agent
  config add-executor <name> <executor.json>   register an executor worker
  config remove <name>

Identity:
  whoami

Read:
  directory [--online] [--domain D]
  group list
  group members <groupId>
  group history <groupId> [--limit N]
  group archive <groupId>
  group unarchive <groupId>
  issue list <groupId> [--status S] [--type task|collaboration]
  issue show <issueId>
  issue events <issueId>
  issue messages <issueId>

Send:
  group send <groupId> <target> <message...>

Issue / collaboration:
  issue create <groupId> --title T [--description D] [--priority low|medium|high|critical]
                         [--assignee <agent>] [--approval-policy r_allow|rw_allow] [--run]
    title 以已注册的 slash command 开头时（如 "/plan ..."）将以对应模式执行。
    /plan：Claude 走 --permission-mode plan；Codex 注入 developerInstructions。
    --assignee 创建后立即把 issue 指派给指定 agent（不会自动起跑）。
    --approval-policy r_allow（默认,写类工具人工审批) / rw_allow（读写都默认通过)。
    --run 创建+指派后立即派发执行；必须同时给 --assignee，且 agent 必须在线。
          append 的 prompt 优先用 --description，缺省 fallback 到 --title。
  issue cancel <issueId>
  issue delete <issueId>
  collab create <groupId> --title T --goal G --participants a,b[,c] [--max-rounds 3] [--owner X]
  collab conclude <issueId> --summary S

Global flags:
  --pretty   format output for humans (tables / indented JSON)
`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  pretty = flags.pretty === true;

  if (positional.length === 0 || flags.help === true || positional[0] === "help") {
    process.stdout.write(HELP);
    return;
  }

  const cmd = positional[0];
  const rest = positional.slice(1);
  const asFlag = flagStr(flags, "as");

  // Config commands don't need an agent
  if (cmd === "config") return cmdConfig(rest, flags);

  const agent = resolveAgent(asFlag);

  switch (cmd) {
    case "whoami":          return cmdWhoami(agent);
    case "directory":       return cmdDirectory(agent, flags);
    case "group":           return cmdGroup(agent, rest, flags);
    case "issue":           return cmdIssue(agent, rest, flags);
    case "collab":          return cmdCollab(agent, rest, flags);
    default: fail(`unknown command: ${cmd}\nRun 'rotom help' for usage.`);
  }
}

// ── config ─────────────────────────────────────────────────────────────────
async function cmdConfig(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  const cfg = loadRotomConfig();
  cfg.agents = cfg.agents || {};

  if (sub === "show") {
    printJson({ configPath: ROTOM_CONFIG, ...cfg });
    return;
  }
  if (sub === "init") {
    if (fs.existsSync(ROTOM_CONFIG)) fail(`${ROTOM_CONFIG} already exists`);
    saveRotomConfig({ agents: {} });
    process.stdout.write(`Created ${ROTOM_CONFIG}\n`);
    return;
  }
  if (sub === "use") {
    const name = rest[1]; if (!name) fail("usage: rotom config use <name>");
    if (!cfg.agents?.[name]) fail(`agent "${name}" not registered`);
    cfg.defaultAgent = name; saveRotomConfig(cfg);
    process.stdout.write(`defaultAgent = ${name}\n`); return;
  }
  if (sub === "add-openclaw" || sub === "add-executor") {
    const name = rest[1]; const cfgPath = rest[2];
    if (!name || !cfgPath) fail(`usage: rotom config ${sub} <name> <path>`);
    const abs = path.resolve(expandHome(cfgPath));
    if (!fs.existsSync(abs)) fail(`config file not found: ${abs}`);
    const kind = sub === "add-openclaw" ? "openclaw" : "executor";
    cfg.agents[name] = { configPath: abs, kind };
    if (!cfg.defaultAgent) cfg.defaultAgent = name;
    saveRotomConfig(cfg);
    // verify it actually resolves
    const resolved = resolveAgentFromEntry(name, cfg.agents[name]);
    process.stdout.write(`Registered ${name} (${kind}) → master=${resolved.master}\n`);
    return;
  }
  if (sub === "remove") {
    const name = rest[1]; if (!name) fail("usage: rotom config remove <name>");
    if (!cfg.agents[name]) fail(`agent "${name}" not registered`);
    delete cfg.agents[name];
    if (cfg.defaultAgent === name) delete cfg.defaultAgent;
    saveRotomConfig(cfg);
    process.stdout.write(`Removed ${name}\n`); return;
  }
  fail(`unknown config subcommand: ${sub || "(none)"}`);
}

// ── whoami ─────────────────────────────────────────────────────────────────
async function cmdWhoami(agent: ResolvedAgent): Promise<void> {
  const remote = await api(agent, "GET", "/whoami");
  printJson({ local: { name: agent.name, kind: agent.kind, master: agent.master, configPath: agent.configPath }, remote });
}

// ── directory ──────────────────────────────────────────────────────────────
async function cmdDirectory(agent: ResolvedAgent, flags: Record<string, string | boolean>): Promise<void> {
  const route = flags.online === true ? "/agents/online" : "/agents";
  let data = await api(agent, "GET", route);
  const domain = flagStr(flags, "domain");
  if (domain) data = data.filter((a: any) => a.domain === domain);
  printTable(data.map((a: any) => ({ name: a.name, domain: a.domain || "-", status: a.status, description: (a.description || "").slice(0, 60) })),
    ["name", "domain", "status", "description"]);
}

// ── group ──────────────────────────────────────────────────────────────────
async function cmdGroup(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "list") {
    const data = await api(agent, "GET", "/groups");
    printTable(data.map((g: any) => ({ id: g.id, name: g.name, members: (g.members?.length ?? 0), created_at: g.created_at, archived: g.archived_at ? 'yes' : '' })),
      ["id", "name", "members", "created_at", "archived"]);
    return;
  }
  if (sub === "members") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group members <groupId>");
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}`);
    printTable((data.members || []).map((m: any) => ({ agent_name: m.agent_name, joined_at: m.joined_at })),
      ["agent_name", "joined_at"]);
    return;
  }
  if (sub === "history") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom group history <groupId>");
    const limit = flagInt(flags, "limit") ?? 50;
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}/messages?limit=${limit}`);
    printTable(data.map((m: any) => ({ time: m.created_at, sender: m.sender, content: (m.content || "").replace(/\s+/g, " ").slice(0, 80) })),
      ["time", "sender", "content"]);
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

// ── issue ──────────────────────────────────────────────────────────────────
async function cmdIssue(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "list") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom issue list <groupId> [--status S] [--type task|collaboration]");
    const qs = new URLSearchParams();
    const status = flagStr(flags, "status"); if (status) qs.set("status", status);
    const type = flagStr(flags, "type"); if (type) qs.set("type", type);
    const route = `/groups/${encodeURIComponent(groupId)}/issues${qs.toString() ? `?${qs}` : ""}`;
    const data = await api(agent, "GET", route);
    printTable(data.map((i: any) => ({ id: i.id, type: i.type, status: i.status, priority: i.priority, title: (i.title || "").slice(0, 60) })),
      ["id", "type", "status", "priority", "title"]);
    return;
  }
  if (sub === "show") {
    const id = rest[1]; if (!id) fail("usage: rotom issue show <issueId>");
    const data = await api(agent, "GET", `/issues/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }
  if (sub === "events") {
    const id = rest[1]; if (!id) fail("usage: rotom issue events <issueId>");
    const data = await api(agent, "GET", `/issues/${encodeURIComponent(id)}/events`);
    printTable(data.map((e: any) => ({ time: e.created_at, type: e.event_type, agent: e.agent_name, content: (e.content || "").slice(0, 80) })),
      ["time", "type", "agent", "content"]);
    return;
  }
  if (sub === "messages") {
    const id = rest[1]; if (!id) fail("usage: rotom issue messages <issueId>");
    const data = await api(agent, "GET", `/issues/${encodeURIComponent(id)}/messages`);
    printJson(data);
    return;
  }
  if (sub === "create") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom issue create <groupId> --title T [--description D] [--priority P] [--assignee A] [--approval-policy r_allow|rw_allow] [--run]");
    const title = requireFlag(flags, "title");
    const description = flagStr(flags, "description") || "";
    const priority = flagStr(flags, "priority") || "medium";
    const assignee = flagStr(flags, "assignee");
    const approvalPolicyRaw = flagStr(flags, "approval-policy");
    const run = flags.run === true;
    if (approvalPolicyRaw && approvalPolicyRaw !== "r_allow" && approvalPolicyRaw !== "rw_allow") {
      fail(`--approval-policy must be "r_allow" or "rw_allow"`);
    }
    if (run && !assignee) {
      fail(`--run requires --assignee (cannot start an unassigned issue)`);
    }
    const body: Record<string, unknown> = {
      title,
      description,
      priority,
      createdBy: agent.name,
    };
    if (approvalPolicyRaw) body.approvalPolicy = approvalPolicyRaw;
    const created = await api(agent, "POST", `/groups/${encodeURIComponent(groupId)}/issues`, body);
    const issueId = created?.id as string | undefined;
    if (!issueId) {
      printJson(created);
      return;
    }
    let assigned = false;
    let runPushed: unknown = null;
    if (assignee) {
      await api(agent, "PUT", `/issues/${encodeURIComponent(issueId)}`, { assignedTo: assignee });
      assigned = true;
    }
    if (run) {
      // append 的 prompt 优先用 description,缺省 fallback 到 title——后端要求
      // 非空 prompt 才会派给 worker。
      const prompt = description.trim() || title.trim();
      runPushed = await api(agent, "POST", `/issues/${encodeURIComponent(issueId)}/append`, {
        prompt,
        appendedBy: agent.name,
      });
    }
    printJson({ ...created, assignedTo: assigned ? assignee : null, run: runPushed });
    return;
  }
  if (sub === "cancel") {
    const id = rest[1]; if (!id) fail("usage: rotom issue cancel <issueId>");
    const data = await api(agent, "POST", `/issues/${encodeURIComponent(id)}/cancel`, { cancelledBy: agent.name });
    printJson(data);
    return;
  }
  if (sub === "delete") {
    const id = rest[1]; if (!id) fail("usage: rotom issue delete <issueId>");
    const data = await api(agent, "DELETE", `/issues/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }
  fail(`unknown issue subcommand: ${sub || "(none)"}`);
}

// ── collab ─────────────────────────────────────────────────────────────────
async function cmdCollab(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "create") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom collab create <groupId> --title T --goal G --participants a,b[,c] [--max-rounds 3] [--owner X]");
    const participants = requireFlag(flags, "participants").split(",").map((s) => s.trim()).filter(Boolean);
    if (participants.length < 2) fail("--participants must list at least 2 agents (comma-separated)");
    const body: any = {
      title: requireFlag(flags, "title"),
      collaborationGoal: requireFlag(flags, "goal"),
      participants,
      maxRounds: flagInt(flags, "max-rounds") ?? 3,
      owner: flagStr(flags, "owner") || "",
      createdBy: agent.name,
    };
    const data = await api(agent, "POST", `/groups/${encodeURIComponent(groupId)}/collaborations`, body);
    printJson(data);
    return;
  }
  if (sub === "conclude") {
    const id = rest[1]; if (!id) fail("usage: rotom collab conclude <issueId> --summary S");
    const summary = requireFlag(flags, "summary");
    const data = await api(agent, "POST", `/issues/${encodeURIComponent(id)}/conclude-collaboration`, { summary });
    printJson(data);
    return;
  }
  fail(`unknown collab subcommand: ${sub || "(none)"}`);
}

main().catch((e: Error) => fail(e.message));
