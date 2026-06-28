/**
 * rotom — shared types, config management, HTTP client, output helpers, CLI arg parsing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// ── Constants ─────────────────────────────────────────────────────────────

export const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
export const ROTOM_CONFIG = path.join(ROTOM_HOME, "config.json");
export const DEFAULT_EXECUTOR_CONFIG = path.join(ROTOM_HOME, "executor.config.json");

// ── Types ─────────────────────────────────────────────────────────────────

export interface RotomAgentEntry {
  configPath: string;
  kind: "openclaw" | "executor";
}

export interface RotomConfig {
  defaultAgent?: string;
  agents?: Record<string, RotomAgentEntry>;
}

export interface ResolvedAgent {
  name: string;
  master: string;
  token: string;
  kind: "openclaw" | "executor";
  configPath: string;
}

// ── Path helpers ──────────────────────────────────────────────────────────

export function expandHome(p: string): string {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

export function installRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

export function runShellScript(scriptRel: string, args: string[]): Promise<number> {
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

// ── Config load / save ────────────────────────────────────────────────────

export function loadRotomConfig(): RotomConfig {
  if (!fs.existsSync(ROTOM_CONFIG)) return {};
  try { return JSON.parse(fs.readFileSync(ROTOM_CONFIG, "utf-8")) as RotomConfig; }
  catch (e) { fail(`failed to parse ${ROTOM_CONFIG}: ${(e as Error).message}`); }
}

export function saveRotomConfig(cfg: RotomConfig): void {
  if (!fs.existsSync(ROTOM_HOME)) fs.mkdirSync(ROTOM_HOME, { recursive: true });
  fs.writeFileSync(ROTOM_CONFIG, JSON.stringify(cfg, null, 2));
}

export function resolveFromExecutorConfig(name: string, configPath: string): ResolvedAgent | null {
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

export function listExecutorWorkers(configPath: string): string[] {
  if (!fs.existsSync(configPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const workers: any[] = Array.isArray(raw?.workers)
      ? raw.workers
      : (raw?.name ? [raw] : []);
    return workers.map((w) => w?.name).filter(Boolean);
  } catch { return []; }
}

export function resolveAgentFromEntry(name: string, entry: RotomAgentEntry): ResolvedAgent {
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

  const resolved = resolveFromExecutorConfig(name, p);
  if (!resolved) fail(`executor config ${p} has no worker named "${name}"`);
  return resolved;
}

export function resolveAgent(asFlag?: string): ResolvedAgent {
  const cfg = loadRotomConfig();
  const chosen = process.env.ROTOM_AGENT || asFlag || cfg.defaultAgent;
  process.stderr.write(`[rotom] Resolving agent with --as=${asFlag} ROTOM_AGENT=${process.env.ROTOM_AGENT} defaultAgent=${cfg.defaultAgent}\n`);
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

  const fromExecutor = resolveFromExecutorConfig(chosen, DEFAULT_EXECUTOR_CONFIG);
  if (fromExecutor) return fromExecutor;

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

// ── HTTP client ───────────────────────────────────────────────────────────

export function masterHttpUrl(masterWsOrHttp: string): string {
  return masterWsOrHttp
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://")
    .replace(/\/+$/, "");
}

export async function api(agent: ResolvedAgent, method: string, route: string, body?: unknown): Promise<any> {
  const url = `${masterHttpUrl(agent.master)}/api${route}`;
  const init: RequestInit = {
    method,
    headers: {
      "Authorization": `Bearer ${agent.token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) (init as any).body = JSON.stringify(body);

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
      const partial = resp !== undefined;
      if (attempt < maxAttempts && !partial) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      failKind(partial ? "partial-response" : "network", url, reason, partial ? resp!.status : 0);
    }
  }
  throw new Error("rotom: api() loop fell through");
}

// ── Output helpers ────────────────────────────────────────────────────────

export let pretty = false;

export function setPretty(v: boolean): void { pretty = v; }

export function isPretty(): boolean { return pretty; }

export function printJson(data: any): void {
  process.stdout.write(JSON.stringify(data, null, pretty ? 2 : 0) + "\n");
}

export function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
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

export function fail(msg: string): never {
  process.stderr.write(`rotom: ${msg}\n`);
  process.exit(1);
}

export function failKind(kind: "network" | "partial-response" | "http" | "generic", ...args: unknown[]): never {
  const prefix = kind === "network"
    ? "rotom network"
    : kind === "partial-response"
    ? "rotom partial-response"
    : kind === "http"
    ? "rotom http"
    : "rotom";
  process.stderr.write(`${prefix}: ${args.map((a) => String(a)).join(" ")}\n`);
  const code = kind === "network" || kind === "partial-response" ? 75 :
    kind === "http" ? 69 : 1;
  process.exit(code);
}

// ── CLI arg parsing ───────────────────────────────────────────────────────

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        flags[k] = v === "" ? true : v;
      } else {
        if (a.startsWith("--no-")) { flags[a.slice(5)] = false; continue; }
        flags[a.slice(2)] = true;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      flags[a[1]] = true;
    } else {
      positional.push(a);
    }
  }
  for (const key of Object.keys(flags)) {
    if (flags[key] !== true) continue;
    const idx = argv.indexOf(`--${key}`);
    if (idx === -1 && key.length === 1) continue;
    if (idx === -1) continue;
    const valIdx = idx + 1;
    if (valIdx < argv.length && !argv[valIdx].startsWith("-")) {
      const m = argv[valIdx].match(/^-?\d+(\.\d+)?$/);
      if (m) {
        flags[key] = m[0];
      } else {
        flags[key] = argv[valIdx];
      }
    }
  }
  return { positional, flags };
}

export function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (v === undefined || v === true || v === false) {
    fail(`--${name} is required`);
  }
  return v;
}

export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  if (v === undefined || v === true || v === false) return undefined;
  return v;
}

export function flagInt(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flagStr(flags, name);
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number`);
  return n;
}
