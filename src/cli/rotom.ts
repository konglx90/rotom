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
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import * as readline from "node:readline";
import { cmdE2ed } from "./e2ed.js";

const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const ROTOM_CONFIG = path.join(ROTOM_HOME, "config.json");
const DEFAULT_EXECUTOR_CONFIG = path.join(ROTOM_HOME, "executor.config.json");
const ROTOM_SKILL_MD = path.join(ROTOM_HOME, "SKILL.md");

/**
 * 把仓库内的 `skill/rotom-a2a-communicate/SKILL.md` 写到 `~/.rotom/SKILL.md`。
 *
 * 幂等:内容相同就跳过,不触发文件 mtime 变化(避免和正在跑的 agent 抢文件)。
 * 这个文件是 rotom 自家的"完整 rotom CLI 命令参考" — 跟 `src/shared/rotom-cli-prompt.ts`
 * 里的 [rotom CLI 使用规则] 段配对使用:prompt 段塞短 hint,agent 真要查命令时
 * 自己 `Read ~/.rotom/SKILL.md`。这样不依赖任何 provider 的 skill 机制。
 */
function ensureRotomSkillMd(): void {
  try {
    // 解析仓库根:本文件位于 src/cli/rotom.ts (开发) 或 dist/cli/rotom.js (打包),
    // 仓库根 = __dirname/../..(开发时是 src/cli/..=repo, 打包后是 dist/cli/..=repo)
    // ESM 没有 __dirname —— 用 import.meta.url 反推。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const skillSrc = path.join(here, "..", "..", "skill", "rotom-a2a-communicate", "SKILL.md");
    if (!fs.existsSync(skillSrc)) {
      // 仓库内没找到 SKILL.md(可能是 npm 全局安装但 files 配置漏了 skill/),跳过
      return;
    }
    const content = fs.readFileSync(skillSrc, "utf-8");
    let needsWrite = true;
    if (fs.existsSync(ROTOM_SKILL_MD)) {
      try {
        const existing = fs.readFileSync(ROTOM_SKILL_MD, "utf-8");
        if (existing === content) needsWrite = false;
      } catch { /* 读失败 → 重写 */ }
    }
    if (needsWrite) {
      if (!fs.existsSync(ROTOM_HOME)) fs.mkdirSync(ROTOM_HOME, { recursive: true });
      fs.writeFileSync(ROTOM_SKILL_MD, content, "utf-8");
    }
  } catch (err: any) {
    // 静默失败 — 不阻塞主命令。SKILL.md 是 best-effort,rotom 不强依赖。
    process.stderr.write(`[rotom] WARN: failed to write ~/.rotom/SKILL.md: ${err.message}\n`);
  }
}

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

/**
 * 安装/仓库根。两种情形都解析到同一个根:
 *   - 编译产物: import.meta.url = file://.../dist/cli/rotom.js → dirname → <root>/dist/cli
 *   - tsx 开发: import.meta.url = file://.../src/cli/rotom.ts   → dirname → <root>/src/cli
 *   - resolve(here, "..", "..") 始终等于 <root>。
 * Master / executor 子命令靠这个根找 bin/mesh-master.sh 与 dist/executor/index.js。
 */
function installRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function runShellScript(scriptRel: string, args: string[]): Promise<number> {
  const scriptPath = path.join(installRoot(), scriptRel);
  if (!fs.existsSync(scriptPath)) {
    fail(`shell script not found: ${scriptPath}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [scriptPath, ...args], { stdio: "inherit" });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => resolve(code ?? 1));
  });
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

  // 幂等方法最多重试 1 次(应对 HTTP/1.1 keep-alive socket reset 等瞬时网络错);
  // POST 等非幂等方法不重试,避免 master 已处理 + client 不知道时双发。
  const idempotent = method === "GET" || method === "PUT" || method === "DELETE";
  const maxAttempts = idempotent ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp: Response | undefined;
    try {
      resp = await fetch(url, init);
      const text = await resp.text();
      let data: any;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!resp.ok) {
        const detail = typeof data === "object" && data?.error ? data.error : text;
        failKind("http", url, resp.status, method, route, detail);
      }
      return data;
    } catch (e) {
      const reason = (e as Error).message;
      // resp 未定义 → fetch() 阶段抛,可能是连接失败 / 握手失败 / 响应 headers 解析前被 reset
      // resp 已定义 → resp.text() 阶段抛,server 大概率已处理请求(headers 都收齐了)
      const partial = resp !== undefined;
      if (attempt < maxAttempts && !partial) {
        // 网络层失败 + 还有重试机会 → 短暂 sleep 后重试一次
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      failKind(partial ? "partial-response" : "network", url, reason, partial ? resp!.status : 0);
    }
  }
  // 不可达(循环总是通过 failKind 退出)
  throw new Error("rotom: api() loop fell through");
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

// 把 rotom CLI 的失败分成三类 ——
//
// 背景:agent 在 shell 里跑 rotom 命令,看到 stderr 一行就回话。原本所有错都
// 长成 `rotom: <text>`,LLM 倾向把"网络层失败"和"HTTP 业务错"混在一起,再
// 加一条 `|| echo "X failed (master down)"` 兜底就会把任何 rotom 失败都总结成
// "rotom 没启动"报给用户(参见 plans/twinkly-waddling-creek.md 的诊断)。
//
// 这里把三类错误的 stderr 前缀明确分开:
//   - network:           fetch() 抛异常(连接失败 / socket reset / DNS 等)。
//                        exit 75 (EX_TEMPFAIL)。注意:HTTP/1.1 keep-alive 下
//                        server 可能已 accept + log + 处理完请求,client 在响应
//                        headers 解析前就被对端 reset — 这种情况走 network 分支
//                        但 server 端其实有处理记录。提示里要 LLM 自检。
//   - partial-response:  fetch() 成功拿到 Response(status + headers 都有了),
//                        但 resp.text() 抛(body stream 被截断)。这种 case
//                        server 几乎肯定已处理请求,exit 75 但**不**自动重试,
//                        提示 LLM 先查 master log 避免 POST 重复落库。
//   - http:              server 正常返回了 HTTP <s> 响应,且是 4xx/5xx。
//                        exit 1,前缀写"command failed"+"this is a command error,
//                        master is up",让 LLM 看到后能明确"master 是好的,
//                        问题在我这条命令"。
function failKind(kind: "network" | "partial-response" | "http" | "generic", ...args: unknown[]): never {
  let prefix: string;
  let exit: number;
  switch (kind) {
    case "network": {
      const url = String(args[0] ?? "");
      const reason = String(args[1] ?? "");
      prefix =
        `network error talking to master at ${url}: ${reason}\n` +
        `  next: run \`rotom status\` to verify reachability.\n` +
        `  caveat: on HTTP/1.1 keep-alive sockets, the request may have reached master but the\n` +
        `          response was cut off — check master log to see if your request was processed.`;
      exit = 75; // EX_TEMPFAIL — distinguishes "transient master unreachable" from "command error"
      break;
    }
    case "partial-response": {
      const url = String(args[0] ?? "");
      const reason = String(args[1] ?? "");
      const status = Number(args[2] ?? 0);
      prefix =
        `response from master was interrupted at ${url}: ${reason}\n` +
        `  status: master sent ${status} (headers received) but the body stream was cut off mid-flight.\n` +
        `  warning: master very likely received and processed your request. Do NOT blindly retry\n` +
        `            non-idempotent operations (POST that creates resources) — check master log first.`;
      exit = 75; // also EX_TEMPFAIL — same "transient" semantics, but distinct prefix for LLM
      break;
    }
    case "http": {
      const url = String(args[0] ?? "");
      const status = String(args[1] ?? "");
      const method = String(args[2] ?? "");
      const route = String(args[3] ?? "");
      const detail = String(args[4] ?? "");
      prefix = `command failed: HTTP ${status} ${method} ${route} (url=${url}): ${detail} (this is a command error, master is up — fix the command and retry)`;
      exit = 1;
      break;
    }
    default:
      prefix = String(args[0] ?? "");
      exit = 1;
  }
  process.stderr.write(`rotom: ${prefix}\n`);
  process.exit(exit);
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

Bootstrap (first-time setup):
  init                                         detect claude/codex/hermes, ask for
                                               names + master IP, register agents,
                                               and write ~/.rotom/executor.config.json
    Flags:
      --master <ip:port>     skip prompt (default: 127.0.0.1:28800)
      --domain <name>        skip prompt (default: pick from master's existing
                             domains; falls back to "默认部门" or "default")
      --name-prefix <p>      default name = <p>-<tool>  (default: $USER)
      --tools <a,b,c>        limit detection to a subset of claude,codex,hermes
      --yes / -y             accept all defaults, do not overwrite without confirm
      --force                overwrite existing executor.config.json without prompt

Identity:
  whoami
  status                                        master health check (no agent needed)

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
  issue comment <issueId> --message M [--reply-to <eventId>]

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
  issue update <issueId> [--title T] [--description D] [--priority low|medium|high|critical]
                         [--assignee <agent> | --unassign] [--approval-policy r_allow|rw_allow]
    局部更新 issue 字段。至少给一个 flag。
    --assignee / --unassign 互斥。
  issue cancel <issueId>
  issue delete <issueId>
  collab create <groupId> --title T --goal G --participants a,b[,c] [--max-rounds 3] [--owner X]
  collab conclude <issueId> --summary S

Note (极简文字记录,纯 CRUD):
  note list <groupId>
  note show <noteId>
  note create <groupId> --title T [--description D]
  note update <noteId> [--title T] [--description D]
  note delete <noteId>

E2ED (End-to-End Delivery):
  e2ed start <file|text> [--title T] [--cwd DIR]     create requirement
  e2ed ls                                              list requirements
  e2ed show <groupId>                                  show requirement details
  e2ed deliver <groupId> [--plan-only|--code-only] [--fix]  start delivery
  e2ed review <groupId> [--type requirement|plan|code]      start review
  e2ed metrics <groupId>                               show metrics
  e2ed timeline <groupId>                              show event timeline

Process lifecycle (local daemon control — do not require an agent):
  master <start|stop|restart|status> [--daemon] [--port N] [--host A] [--data D] [--dev]
  master:start | master:stop | master:status | master:restart   (alias)
  executor [--config <path>]      start executor workers (reads ~/.rotom/executor.config.json by default)

Global flags:
  --pretty   format output for humans (tables / indented JSON)
`;

async function main(): Promise<void> {
  // 启动时把 SKILL.md 落到 ~/.rotom/。幂等(内容相同则跳过),best-effort。
  ensureRotomSkillMd();

  const { positional, flags } = parseArgs(process.argv.slice(2));
  pretty = flags.pretty === true;

  if (positional.length === 0 || flags.help === true || positional[0] === "help") {
    process.stdout.write(HELP);
    return;
  }

  const cmd = positional[0];
  const rest = positional.slice(1);
  const asFlag = flagStr(flags, "as");

  // Config and e2ed commands don't need an agent
  if (cmd === "config") return cmdConfig(rest, flags);
  if (cmd === "e2ed")   return cmdE2ed(rest, flags);
  if (cmd === "init")   return cmdInit(rest, flags);

  // Master / executor lifecycle — also do not require an agent.
  // Support both space form (master start) and colon alias (master:start).
  if (cmd === "master" || cmd === "master:start" || cmd === "master:stop" ||
      cmd === "master:status" || cmd === "master:restart") {
    return cmdMaster(colonExpand(cmd, rest), flags);
  }
  if (cmd === "executor") {
    return cmdExecutor(rest, flags);
  }
  if (cmd === "status") {
    return cmdStatus(rest, flags);
  }

  const agent = resolveAgent(asFlag);

  switch (cmd) {
    case "whoami":          return cmdWhoami(agent);
    case "directory":       return cmdDirectory(agent, flags);
    case "group":           return cmdGroup(agent, rest, flags);
    case "issue":           return cmdIssue(agent, rest, flags);
    case "note":            return cmdNote(agent, rest, flags);
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

// ── status (master health, no agent required) ─────────────────────────────
//
// LLM agent 自检:看到 rotom 命令失败时,先跑 `rotom status` 确认 master 是否
// 可达,再决定是修命令还是修 master。这里走 /health(无鉴权,master server.ts:139),
// 失败时复用 failKind('network', ...) 让 LLM 看到统一前缀 + exit 75。
function resolveMasterUrlForStatus(): string {
  if (process.env.ROTOM_MASTER) return process.env.ROTOM_MASTER;
  // ~/.rotom/executor.config.json 顶层 master 字段(worker 共享)
  try {
    if (fs.existsSync(DEFAULT_EXECUTOR_CONFIG)) {
      const raw = JSON.parse(fs.readFileSync(DEFAULT_EXECUTOR_CONFIG, "utf-8"));
      if (typeof raw?.master === "string" && raw.master) return raw.master;
    }
  } catch { /* fall through */ }
  return "ws://127.0.0.1:28800";
}

async function cmdStatus(_rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const masterWs = resolveMasterUrlForStatus();
  const url = `${masterHttpUrl(masterWs)}/health`;
  // GET 是幂等的,允许 1 次重试以应对 keep-alive socket reset
  let resp: Response | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      resp = await fetch(url, { method: "GET" });
      const text = await resp.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* keep empty */ }
      if (!resp.ok) {
        failKind("http", url, resp.status, "GET", "/health", `health endpoint returned ${resp.status}`);
      }
      printJson({
        master: masterWs,
        reachable: true,
        status: data.status ?? "ok",
        agents: {
          total: data.total ?? null,
          online: data.online ?? null,
        },
        domains: data.domains ?? null,
        checkedAt: new Date().toISOString(),
      });
      return;
    } catch (e) {
      const reason = (e as Error).message;
      const partial = resp !== undefined;
      if (attempt < 2 && !partial) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      failKind(partial ? "partial-response" : "network", url, reason, partial ? resp!.status : 0);
    }
  }
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
    if (pretty) {
      printTable(data.map((m: any) => {
        const quoted = m.quoted
          ? `> ${(m.quoted.agent_name || "").slice(0, 10)}: ${(m.quoted.content || "").slice(0, 30)}`
          : "";
        return {
          id: m.id,
          type: m.event_type,
          agent: m.agent_name,
          content: (m.content || "").slice(0, 60),
          quoted: quoted,
          created_at: m.created_at,
        };
      }), ["id", "type", "agent", "content", "quoted", "created_at"]);
    } else {
      printJson(data);
    }
    return;
  }
  if (sub === "comment") {
    const id = rest[1]; if (!id) fail("usage: rotom issue comment <issueId> --message M [--reply-to <eventId>]");
    const message = requireFlag(flags, "message");
    const replyTo = flagInt(flags, "reply-to");
    const data = await api(agent, "POST", `/issues/${encodeURIComponent(id)}/comments`, {
      agentName: agent.name, content: message, replyTo: replyTo ?? undefined,
    });
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
  if (sub === "update") {
    const id = rest[1]; if (!id) fail("usage: rotom issue update <issueId> [--title T] [--description D] [--priority low|medium|high|critical] [--assignee A | --unassign] [--approval-policy r_allow|rw_allow]");
    const title = flagStr(flags, "title");
    const description = flagStr(flags, "description");
    const priority = flagStr(flags, "priority");
    const assignee = flagStr(flags, "assignee");
    const unassign = flags.unassign === true;
    const approvalPolicyRaw = flagStr(flags, "approval-policy");

    if (assignee !== undefined && unassign) {
      fail(`--assignee and --unassign are mutually exclusive`);
    }
    if (priority !== undefined && !["low", "medium", "high", "critical"].includes(priority)) {
      fail(`--priority must be one of low|medium|high|critical (got: ${priority})`);
    }
    if (approvalPolicyRaw !== undefined && approvalPolicyRaw !== "r_allow" && approvalPolicyRaw !== "rw_allow") {
      fail(`--approval-policy must be "r_allow" or "rw_allow" (got: ${approvalPolicyRaw})`);
    }

    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (priority !== undefined) body.priority = priority;
    if (assignee !== undefined) body.assignedTo = assignee;
    else if (unassign) body.assignedTo = null;
    if (approvalPolicyRaw !== undefined) body.approvalPolicy = approvalPolicyRaw;

    if (Object.keys(body).length === 0) {
      fail(`no fields to update — pass at least one of --title, --description, --priority, --assignee, --unassign, --approval-policy`);
    }

    const data = await api(agent, "PUT", `/issues/${encodeURIComponent(id)}`, body);
    printJson(data);
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

// ── note ───────────────────────────────────────────────────────────────────
// Note 是 issue 的极简版:只做纯文字记录,无执行流程/状态/事件流。
async function cmdNote(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  if (sub === "list") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom note list <groupId>");
    const data = await api(agent, "GET", `/groups/${encodeURIComponent(groupId)}/notes`);
    printTable(
      data.map((n: any) => ({
        id: n.id,
        title: (n.title || "").slice(0, 60),
        created_by: n.created_by,
        updated_at: n.updated_at,
      })),
      ["id", "title", "created_by", "updated_at"],
    );
    return;
  }
  if (sub === "show") {
    const id = rest[1]; if (!id) fail("usage: rotom note show <noteId>");
    const data = await api(agent, "GET", `/notes/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }
  if (sub === "create") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom note create <groupId> --title T [--description D]");
    const title = requireFlag(flags, "title");
    const description = flagStr(flags, "description") || "";
    const data = await api(agent, "POST", `/groups/${encodeURIComponent(groupId)}/notes`, {
      title, description, createdBy: agent.name,
    });
    printJson(data);
    return;
  }
  if (sub === "update") {
    const id = rest[1]; if (!id) fail("usage: rotom note update <noteId> [--title T] [--description D]");
    const title = flagStr(flags, "title");
    const description = flagStr(flags, "description");
    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (Object.keys(body).length === 0) {
      fail(`no fields to update — pass at least one of --title, --description`);
    }
    const data = await api(agent, "PUT", `/notes/${encodeURIComponent(id)}`, body);
    printJson(data);
    return;
  }
  if (sub === "delete") {
    const id = rest[1]; if (!id) fail("usage: rotom note delete <noteId>");
    const data = await api(agent, "DELETE", `/notes/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }
  fail(`unknown note subcommand: ${sub || "(none)"}`);
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

// ── master / executor lifecycle ───────────────────────────────────────────
//
// `rotom master {start|stop|restart|status}` 和 `rotom executor` 调度的是本机进程，
// 不需要 master token —— 跟 `rotom config` / `rotom e2ed` / `rotom init` 一类。
// Master 走 bin/mesh-master.sh(它处理 PID / 日志 / 端口探测 / launchctl + systemd)；
// executor 走 dist/executor/index.js(发布包)或 src/executor/index.ts(开发) + tsx。

/**
 * 接受 `master:start` 这种冒号 alias,把它展开成 [`master`, `start`, ...rest]。
 * 空格形式 (`master start`) 已经在 main() 里用 `cmd === "master"` 命中,这里只处理冒号。
 */
function colonExpand(cmd: string, rest: string[]): string[] {
  const colon = cmd.indexOf(":");
  if (colon === -1) return rest;
  return [cmd.slice(colon + 1), ...rest];
}

async function cmdMaster(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];
  const args: string[] = [];
  switch (sub) {
    case "start":
    case "stop":
    case "status":
    case "restart":
      args.push(sub); break;
    default:
      fail(
        `usage: rotom master <start|stop|status|restart> [--daemon] [--port N] [--host A] [--data D] [--dev]\n` +
        `       (also accepts colon form: rotom master:start | master:stop | master:status | master:restart)`,
      );
  }
  if (flags.daemon === true && (sub === "start" || sub === "restart")) args.push("--daemon");
  if (flags.dev === true && sub === "start") args.push("--dev");
  const port = flagStr(flags, "port");   if (port && sub === "start") args.push("--port", port);
  const host = flagStr(flags, "host");   if (host && sub === "start") args.push("--host", host);
  const data = flagStr(flags, "data");   if (data && sub === "start") args.push("--data", data);
  let code: number;
  try { code = await runShellScript("bin/mesh-master.sh", args); }
  catch (e) { fail(`failed to invoke bin/mesh-master.sh: ${(e as Error).message}`); }
  // mesh-master.sh status 在未运行时 exit 1,这种情况 rotom 也透传 exit code(让
  // shell 脚本能链 && / || 判断)。其它子命令的 exit code 同样透传。
  process.exit(code);
}

async function cmdExecutor(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const root = installRoot();
  const distJs = path.join(root, "dist", "executor", "index.js");
  const srcTs  = path.join(root, "src", "executor", "index.ts");

  // 透传 --config / 额外参数(留给以后扩展)。executor 自己的 argv parser 只识别
  // --config,所以这里加白名单更安全。
  const fwd: string[] = [];
  const cfg = flagStr(flags, "config");
  if (cfg) fwd.push("--config", cfg);
  // 透传 rotom 还没识别的尾部位置参数(防御性:目前 rest 由 main() 截断成空,留口子)
  for (const a of rest) fwd.push(a);

  let useTsx = false;
  let entry: string;
  if (fs.existsSync(distJs)) {
    entry = distJs;
  } else if (fs.existsSync(srcTs)) {
    const tsxBin = path.join(root, "node_modules", ".bin", "tsx");
    if (!fs.existsSync(tsxBin)) {
      fail(`tsx not found at ${tsxBin} — required for dev mode. Run \`pnpm install\` first.`);
    }
    entry = tsxBin;
    useTsx = true;
  } else {
    fail(`cannot find executor entry: tried ${distJs} and ${srcTs}`);
  }

  const cmdline = useTsx
    ? [entry, srcTs, ...fwd]
    : [entry, ...fwd];
  const bin = useTsx ? entry : process.execPath;

  await new Promise<void>((resolve) => {
    const child = spawn(bin, cmdline, { stdio: "inherit" });
    const forward = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* already gone */ } };
    process.on("SIGINT",  () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));
    child.on("exit", (code, signal) => {
      if (code !== null && code !== undefined) { process.exit(code); return; }
      // 被信号杀 → 按 128+sigNum 退出(常见 shell 期望)
      const sigNum = signal ? os.constants.signals[signal] : 0;
      process.exit(typeof sigNum === "number" && sigNum > 0 ? 128 + sigNum : 1);
      resolve();
    });
    child.on("error", (err) => fail(`failed to spawn executor: ${err.message}`));
  });
}

// ── init ──────────────────────────────────────────────────────────────────
//
// First-time bootstrap:
//   1. detect installed CLI tools (claude/codex/hermes, optionally more)
//   2. ask user which to register + custom name per tool
//   3. ask for master IP:port
//   4. resolve (or create) a domain on the master
//   5. POST /api/agents for each, collecting the returned mesh_xxx tokens
//   6. write ~/.rotom/executor.config.json with master + workers[]
//
// Non-interactive override flags make the same flow scriptable.

const INIT_KNOWN_TOOLS = ["claude", "codex", "hermes", "openclaw"] as const;

function detectCliTools(wanted: readonly string[]): { tool: string; path: string }[] {
  const out: { tool: string; path: string }[] = [];
  for (const tool of wanted) {
    try {
      const p = execSync(`command -v ${tool}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (p) out.push({ tool, path: p });
    } catch {
      /* not installed */
    }
  }
  return out;
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function askYN(question: string, defaultYes: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${hint}: `, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      if (a === "y" || a === "yes") return resolve(true);
      if (a === "n" || a === "no") return resolve(false);
      resolve(defaultYes);
    });
  });
}

function askText(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}${suffix}: `, (ans) => {
      rl.close();
      const trimmed = ans.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

interface ParsedMaster {
  host: string;
  port: number;
  url: string;
}

function parseMasterSpec(spec: string, defaultPort: number): ParsedMaster {
  // Accept "host", "host:port", "ws://host:port", "http://host:port"
  let s = spec.trim();
  s = s.replace(/^wss?:\/\//, "").replace(/^https?:\/\//, "");
  s = s.replace(/\/+$/, "");
  let host = s;
  let port = defaultPort;
  const colon = s.lastIndexOf(":");
  if (colon !== -1) {
    const tail = s.slice(colon + 1);
    const n = Number(tail);
    if (Number.isInteger(n) && n > 0 && n < 65536) {
      host = s.slice(0, colon);
      port = n;
    }
  }
  if (!host) fail(`invalid master spec: ${spec}`);
  return { host, port, url: `ws://${host}:${port}` };
}

async function httpJsonNoAuth(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) (init as any).body = JSON.stringify(body);
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    fail(`network error calling ${url}: ${(e as Error).message}`);
  }
  const text = await resp.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, data };
}

interface DomainInfo { id: string; name: string; }

async function listMasterDomains(httpBase: string): Promise<DomainInfo[]> {
  const { status, data } = await httpJsonNoAuth("GET", `${httpBase}/api/domains`);
  if (status !== 200 || !Array.isArray(data)) return [];
  return data.map((d: any) => ({ id: d.id, name: d.name }));
}

async function ensureDomain(httpBase: string, name: string): Promise<DomainInfo> {
  const existing = await listMasterDomains(httpBase);
  const hit = existing.find((d) => d.name === name);
  if (hit) return hit;
  const { status, data } = await httpJsonNoAuth("POST", `${httpBase}/api/domains`, {
    name,
    description: `Created by 'rotom init' at ${new Date().toISOString()}`,
  });
  if (status === 201 && data?.id) return { id: data.id, name: data.name };
  if (status === 409) {
    // Race: someone created it. Re-fetch.
    const after = await listMasterDomains(httpBase);
    const again = after.find((d) => d.name === name);
    if (again) return again;
  }
  fail(`failed to create domain "${name}" (HTTP ${status}): ${JSON.stringify(data)}`);
}

interface RegisteredAgent { name: string; cliTool: string; token: string; }

async function registerAgent(httpBase: string, name: string, domain: string, cliTool: string): Promise<RegisteredAgent> {
  const { status, data } = await httpJsonNoAuth("POST", `${httpBase}/api/agents`, {
    name,
    domain,
    profile: {
      category: "Agent",
      position: `${cliTool} 后端`,
      responsibilities: "由 rotom init 自动注册",
      tech_stack: cliTool,
    },
  });
  if (status === 201 && data?.token) {
    return { name, cliTool, token: data.token };
  }
  if (status === 409) {
    fail(`agent "${name}" already exists on master. Pick a different name (or delete the existing one first).`);
  }
  fail(`failed to register "${name}" (HTTP ${status}): ${JSON.stringify(data)}`);
}

async function pickDomain(master: ParsedMaster, hintFlag?: string, yesMode = false): Promise<string> {
  const httpBase = `http://${master.host}:${master.port}`;
  const existing = await listMasterDomains(httpBase);
  if (hintFlag) {
    if (!existing.find((d) => d.name === hintFlag)) {
      if (yesMode) return ensureDomain(httpBase, hintFlag).then((d) => d.name);
      const create = await askYN(`domain "${hintFlag}" does not exist. Create it?`, true);
      if (!create) fail(`aborted: domain "${hintFlag}" missing on master`);
      return ensureDomain(httpBase, hintFlag).then((d) => d.name);
    }
    return hintFlag;
  }
  if (existing.length === 0) {
    // Pick a sensible default and create.
    const fallback = "默认部门";
    return ensureDomain(httpBase, fallback).then((d) => d.name);
  }
  if (existing.length === 1) return existing[0].name;
  // Multiple domains: prompt unless --yes.
  if (yesMode) {
    // Prefer "默认部门" or any "default" if present.
    const preferred = existing.find((d) => d.name === "默认部门")
      || existing.find((d) => d.name.toLowerCase() === "default")
      || existing[0];
    return preferred.name;
  }
  process.stdout.write(`\nMaster has multiple domains:\n`);
  existing.forEach((d, i) => process.stdout.write(`  ${i + 1}) ${d.name}\n`));
  const idxRaw = await askText(`Pick domain [1-${existing.length}]`, "1");
  const idx = parseInt(idxRaw, 10);
  if (isNaN(idx) || idx < 1 || idx > existing.length) fail("invalid domain selection");
  return existing[idx - 1].name;
}

async function cmdInit(_rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const yesMode = flags.yes === true || flags.y === true;
  const force = flags.force === true;
  const masterSpec = flagStr(flags, "master");
  const domainFlag = flagStr(flags, "domain");
  const namePrefix = flagStr(flags, "name-prefix") || process.env.USER || "user";
  const toolsFlag = flagStr(flags, "tools");

  const wantedTools = (toolsFlag ? toolsFlag.split(",").map((s) => s.trim()).filter(Boolean) : [...INIT_KNOWN_TOOLS]) as string[];

  if (!isInteractive() && !yesMode) {
    fail(`rotom init needs an interactive TTY (or pass --yes to accept all defaults)`);
  }

  if (fs.existsSync(DEFAULT_EXECUTOR_CONFIG) && !force) {
    if (yesMode) {
      fail(`${DEFAULT_EXECUTOR_CONFIG} already exists. Re-run with --force to overwrite.`);
    }
    const overwrite = await askYN(`${DEFAULT_EXECUTOR_CONFIG} already exists. Overwrite?`, false);
    if (!overwrite) {
      process.stdout.write(`Aborted. Existing file left untouched.\n`);
      return;
    }
  }

  process.stdout.write(`\nScanning for CLI tools (${wantedTools.join(", ")})...\n`);
  const detected = detectCliTools(wantedTools);
  if (detected.length === 0) {
    fail(`none of [${wantedTools.join(", ")}] are on PATH. Install at least one, or pass --tools with what's available.`);
  }
  for (const { tool, path: p } of detected) {
    process.stdout.write(`  ✓ ${tool}  (${p})\n`);
  }
  for (const tool of wantedTools) {
    if (!detected.find((d) => d.tool === tool)) process.stdout.write(`  ✗ ${tool}  (not installed)\n`);
  }

  const selected: { tool: string; path: string; name: string }[] = [];
  for (const { tool, path: p } of detected) {
    if (yesMode) {
      selected.push({ tool, path: p, name: `${namePrefix}-${tool}` });
      continue;
    }
    const want = await askYN(`Register ${tool}?`, true);
    if (!want) continue;
    const defaultName = `${namePrefix}-${tool}`;
    const name = (await askText(`  Name for ${tool}`, defaultName)).trim();
    if (!name) fail("name cannot be empty");
    selected.push({ tool, path: p, name });
  }

  if (selected.length === 0) {
    process.stdout.write(`\nNo tools selected. Nothing to do.\n`);
    return;
  }

  const master: ParsedMaster = masterSpec
    ? parseMasterSpec(masterSpec, 28800)
    : yesMode
      ? parseMasterSpec("127.0.0.1:28800", 28800)
      : await (async () => {
          const ip = await askText("Master IP", "127.0.0.1");
          const portStr = await askText("Master port", "28800");
          const port = Number(portStr);
          if (!Number.isInteger(port) || port <= 0) fail("invalid port");
          return { host: ip, port, url: `ws://${ip}:${port}` };
        })();

  process.stdout.write(`\nMaster: ${master.url}\n`);

  // Probe master to fail fast on typos.
  const httpBase = `http://${master.host}:${master.port}`;
  const probe = await httpJsonNoAuth("GET", `${httpBase}/api/domains`).catch(() => null);
  if (!probe || probe.status === 0) {
    fail(`master ${master.url} unreachable. Start it first (e.g. \`mesh-master start --daemon\`) or check the IP.`);
  }
  if (probe.status >= 500) {
    fail(`master ${master.url} returned HTTP ${probe.status}: ${JSON.stringify(probe.data)}`);
  }

  const domain = await pickDomain(master, domainFlag, yesMode);
  process.stdout.write(`Domain: ${domain}\n`);

  process.stdout.write(`\nRegistering ${selected.length} agent(s)...\n`);
  const workers: RegisteredAgent[] = [];
  for (const s of selected) {
    const reg = await registerAgent(httpBase, s.name, domain, s.tool);
    process.stdout.write(`  ✓ ${reg.name}  (${s.tool})  token=${reg.token.slice(0, 12)}…\n`);
    workers.push(reg);
  }

  if (!fs.existsSync(ROTOM_HOME)) fs.mkdirSync(ROTOM_HOME, { recursive: true });

  // 询问 workingDir(base 路径),用于 per-group cwd 派生
  // 默认 ~/.rotom/results —— 与 e2ed pipeline 的 defaultGroupWorkingDir 一致
  const defaultBase = path.join(ROTOM_HOME, "results");
  const workingDir = yesMode
    ? defaultBase
    : (await askText("Working dir base (per-group cwd will be <base>/<groupId>)", defaultBase)).trim();
  if (!workingDir) fail("workingDir cannot be empty");
  if (!path.isAbsolute(workingDir)) {
    if (yesMode) fail(`workingDir must be an absolute path, got: ${workingDir}`);
    const expand = await askYN(`workingDir "${workingDir}" is not absolute. Use as-is?`, false);
    if (!expand) fail("aborted: workingDir must be absolute");
  }

  const cfg = {
    master: master.url,
    workers: workers.map((w) => ({
      name: w.name,
      token: w.token,
      cliTool: w.cliTool,
      workingDir,
      profile: { category: "Agent" },
    })),
  };
  fs.writeFileSync(DEFAULT_EXECUTOR_CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  process.stdout.write(`\nWrote ${DEFAULT_EXECUTOR_CONFIG} with ${workers.length} worker(s).\n`);
  process.stdout.write(`  base workingDir: ${workingDir} (per-group: <base>/<groupId>)\n`);
  process.stdout.write(`Next: run \`pnpm executor\` (or \`rotom executor\`) to connect them.\n`);
}

main().catch((e: Error) => fail(e.message));
