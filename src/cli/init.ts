/**
 * rotom init — first-time bootstrap (detect CLI tools, register agents, write config).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as readline from "node:readline";
import {
  ROTOM_HOME,
  DEFAULT_EXECUTOR_CONFIG,
  fail,
  flagStr,
} from "./common.js";

// ── Bootstrap helpers ─────────────────────────────────────────────────────

const INIT_KNOWN_TOOLS = ["claude", "codex", "hermes", "openclaw", "pi"] as const;

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
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, data };
}

interface DomainInfo {
  name: string;
}

async function listMasterDomains(httpBase: string): Promise<DomainInfo[]> {
  const { status, data } = await httpJsonNoAuth("GET", `${httpBase}/api/domains`);
  if (status !== 200) fail(`failed to list domains: HTTP ${status}`);
  return Array.isArray(data) ? data : data?.domains ?? [];
}

async function ensureDomain(httpBase: string, name: string): Promise<DomainInfo> {
  const { status, data } = await httpJsonNoAuth("POST", `${httpBase}/api/domains`, { name });
  if (status === 200 || status === 201) return data as DomainInfo;
  if (status === 409) return { name }; // already exists
  fail(`failed to create domain "${name}": HTTP ${status} ${JSON.stringify(data)}`);
}

interface RegisteredAgent {
  name: string;
  token: string;
  cliTool: string;
}

async function registerAgent(httpBase: string, name: string, domain: string, cliTool: string): Promise<RegisteredAgent> {
  const { status, data } = await httpJsonNoAuth("POST", `${httpBase}/api/agents`, {
    name, domain, cliTool,
  });
  if (status !== 200 && status !== 201) {
    fail(`failed to register agent "${name}": HTTP ${status} ${JSON.stringify(data)}`);
  }
  return {
    name: (data as any).name ?? name,
    token: (data as any).mesh_token ?? (data as any).token ?? "",
    cliTool,
  };
}

async function pickDomain(master: ParsedMaster, hintFlag?: string, yesMode = false): Promise<string> {
  const httpBase = `http://${master.host}:${master.port}`;
  const existing = await listMasterDomains(httpBase);
  if (hintFlag) {
    const match = existing.find((d) => d.name === hintFlag);
    if (match) return match.name;
    const created = await ensureDomain(httpBase, hintFlag);
    return created.name;
  }
  if (existing.length === 1 && yesMode) return existing[0].name;
  if (existing.length > 0 && !yesMode) {
    process.stdout.write("Existing domains:\n");
    for (const d of existing) process.stdout.write(`  ${d.name}\n`);
    const pick = await askText("Domain to use", existing[0].name);
    const match = existing.find((d) => d.name === pick);
    if (match) return match.name;
    const created = await ensureDomain(httpBase, pick);
    return created.name;
  }
  if (yesMode) {
    const created = await ensureDomain(httpBase, "default");
    return created.name;
  }
  const name = await askText("No domains found. Create domain", "default");
  const created = await ensureDomain(httpBase, name);
  return created.name;
}

// ── cmdInit ───────────────────────────────────────────────────────────────

export async function cmdInit(_rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const yesMode = flags.yes === true || flags.y === true;
  const force = flags.force === true;
  const masterSpec = flagStr(flags, "master");
  const domainFlag = flagStr(flags, "domain");
  const namePrefix = flagStr(flags, "name-prefix") || process.env.USER || "user";
  const toolsFlag = flagStr(flags, "tools");

  const wantedTools = (toolsFlag ? toolsFlag.split(",").map((s) => s.trim()).filter(Boolean) : [...INIT_KNOWN_TOOLS]) as string[];

  if (!isInteractive() && !yesMode) {
    fail("rotom init needs an interactive TTY (or pass --yes to accept all defaults)");
  }

  if (fs.existsSync(DEFAULT_EXECUTOR_CONFIG) && !force) {
    if (yesMode) {
      fail(`${DEFAULT_EXECUTOR_CONFIG} already exists. Re-run with --force to overwrite.`);
    }
    const overwrite = await askYN(`${DEFAULT_EXECUTOR_CONFIG} already exists. Overwrite?`, false);
    if (!overwrite) {
      process.stdout.write("Aborted. Existing file left untouched.\n");
      return;
    }
  }

  process.stdout.write(`\nScanning for CLI tools (${wantedTools.join(", ")})...\n`);
  const detected = detectCliTools(wantedTools);
  if (detected.length === 0) {
    fail(`none of [${wantedTools.join(", ")}] are on PATH. Install at least one, or pass --tools with what's available.`);
  }
  for (const { tool, path: p } of detected) {
    process.stdout.write(`  \u2713 ${tool}  (${p})\n`);
  }
  for (const tool of wantedTools) {
    if (!detected.find((d) => d.tool === tool)) process.stdout.write(`  \u2717 ${tool}  (not installed)\n`);
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
    process.stdout.write("\nNo tools selected. Nothing to do.\n");
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
    process.stdout.write(`  \u2713 ${reg.name}  (${s.tool})  token=${reg.token.slice(0, 12)}...\n`);
    workers.push(reg);
  }

  if (!fs.existsSync(ROTOM_HOME)) fs.mkdirSync(ROTOM_HOME, { recursive: true });

  const defaultBase = path.join(ROTOM_HOME, "artifacts");
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
  process.stdout.write("Next: run \`pnpm executor\` (or \`rotom executor\`) to connect them.\n");
}
