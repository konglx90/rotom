/**
 * rotom join — 首次申请 token 落盘到 ~/.rotom/
 *
 * 给"本地交互式 codex 作为 mesh host"模式用:本机不跑 executor daemon,
 * codex 直接通过 Bash 调 rotom CLI 与 mesh 交互。本命令一次性完成:
 *   1. POST http://<master>/api/agents { name, domain } → 拿到 plaintext token + configTemplate
 *   2. 落盘 configTemplate 到 ~/.rotom/agents/<name>.json(resolveAgentFromEntry 直接能读)
 *   3. 在 ~/.rotom/config.json 的 agents[name] 注册一条 { configPath, kind: "local" }
 *   4. 若 defaultAgent 未设 → 设为 name
 *
 * 之后 codex 通过 Bash 调 `rotom ...`(用 defaultAgent)或 `rotom --as <name> ...`,
 * resolveAgent 自动从本地文件解出 master+token,executor daemon 完全不用起。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  ROTOM_HOME,
  fail,
  flagStr,
  printJson,
} from "./common.js";
import { masterFetch, masterHttpBase, masterWsBase } from "./routes.js";

const DEFAULT_PORT = 28800;

function parseMasterSpec(spec: string): { host: string; port: number; httpUrl: string; wsUrl: string } {
  let s = spec.trim().replace(/^ws:\/\//, "").replace(/^wss:\/\//, "").replace(/^https?:\/\//, "");
  s = s.replace(/\/+$/, "");
  let host = s;
  let port = DEFAULT_PORT;
  const colon = s.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(s.slice(colon + 1))) {
    host = s.slice(0, colon);
    port = parseInt(s.slice(colon + 1), 10);
  }
  if (!host) fail(`invalid master spec: ${spec}`);
  return { host, port, httpUrl: masterHttpBase(host, port), wsUrl: masterWsBase(host, port) };
}

const VALID_CLI_TOOLS = ["claude", "codex", "hermes"] as const;
type CliTool = typeof VALID_CLI_TOOLS[number];

function detectCliTool(): CliTool | null {
  // 跟 rotom init 的 detectCliTools 同款逻辑,但只返回第一个命中的。
  for (const tool of VALID_CLI_TOOLS) {
    try {
      const { execSync } = require("node:child_process");
      const p = execSync(`command -v ${tool}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (p) return tool;
    } catch { /* not installed */ }
  }
  return null;
}

export async function cmdJoin(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const masterSpec = rest[0];
  if (!masterSpec) {
    fail(
      "usage: rotom join <masterHost:port> --name <agentName> --domain <domain>\n" +
      "                            --cli-tool <claude|codex|hermes> [--working-dir PATH]\n" +
      "                            [--profile-position P] [--profile-bio B] [--force]\n" +
      "  首次申请 token 落盘到 ~/.rotom/。一个机器一个 CLI 一个 agent:每次换 CLI 用不同\n" +
      "  --name + --cli-tool 注册,之后 `rotom --as <name> ...` 自动解出 master+token+cliTool。",
    );
  }
  const name = flagStr(flags, "name");
  const domain = flagStr(flags, "domain");
  if (!name) fail("--name is required (the agent name you want to register on master)");
  if (!domain) fail("--domain is required (use an existing domain on master; see dashboard)");

  let cliToolRaw = flagStr(flags, "cli-tool");
  if (!cliToolRaw) {
    cliToolRaw = detectCliTool() ?? "";
    if (!cliToolRaw) {
      fail(`--cli-tool not given and auto-detect failed (none of ${VALID_CLI_TOOLS.join(",")} found in PATH)`);
    }
    process.stderr.write(`[rotom] --cli-tool not given, auto-detected: ${cliToolRaw}\n`);
  }
  if (!VALID_CLI_TOOLS.includes(cliToolRaw as CliTool)) {
    fail(`--cli-tool must be one of ${VALID_CLI_TOOLS.join("|")} (got: ${cliToolRaw})`);
  }
  const cliTool = cliToolRaw as CliTool;

  const workingDir = flagStr(flags, "working-dir") || process.cwd();
  const profilePosition = flagStr(flags, "profile-position");
  const profileBio = flagStr(flags, "profile-bio");
  const profile: Record<string, string> = {};
  if (profilePosition) profile.position = profilePosition;
  if (profileBio) profile.bio = profileBio;

  const force = flags.force === true;

  const { httpUrl, wsUrl } = parseMasterSpec(masterSpec);

  const cfgPath = path.join(ROTOM_HOME, "config.json");
  const cfgExists = fs.existsSync(cfgPath);
  if (cfgExists) {
    // 读取已有 config 检查重名
    try {
      const existing = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      if (existing.agents?.[name] && !force) {
        fail(
          `agent "${name}" already registered in ${cfgPath}.\n` +
          `  重新申请 token(旧 token 作废)请加 --force。`,
        );
      }
    } catch {
      // 配置文件损坏 → 当作不存在,继续
    }
  }

  // 1. POST /api/agents 申请 token
  const registerUrl = `${httpUrl}/api/agents`;
  let resp: { status: number; data: unknown };
  try {
    resp = await masterFetch(registerUrl, {
      method: "POST",
      body: JSON.stringify({ name, domain }),
    });
  } catch (e) {
    fail(`failed to reach master at ${httpUrl}: ${(e as Error).message}\n  run \`rotom status\` to verify reachability`);
  }
  const { status, data: rawData } = resp;
  const text: string = rawData === null ? "" : typeof rawData === "string" ? rawData : JSON.stringify(rawData);
  const data: any = rawData;
  if (status < 200 || status >= 300) {
    const detail = typeof data === "object" && data?.error ? data.error : text;
    fail(`master rejected agent registration (HTTP ${status}): ${detail}`);
  }
  const token: string | undefined = data?.token;
  const agentId: string | undefined = data?.id;
  if (!token || !agentId) {
    fail(`master did not return token/id in registration response: ${text}`);
  }

  // 2. 落盘到 ~/.rotom/agents/<name>.json —— 扁平结构,对齐 executor.config.json
  //    workers[] 单条 entry + master 字段。{ master, name, token, cliTool, workingDir, profile }
  const agentsDir = path.join(ROTOM_HOME, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentFile = path.join(agentsDir, `${name}.json`);
  const agentConfig: Record<string, unknown> = {
    master: wsUrl,
    name,
    token,
    cliTool,
    workingDir,
  };
  if (Object.keys(profile).length > 0) agentConfig.profile = profile;
  fs.writeFileSync(agentFile, JSON.stringify(agentConfig, null, 2));

  // 3. 写 ~/.rotom/config.json 的 agents[name] = { configPath, kind: "local" }
  fs.mkdirSync(ROTOM_HOME, { recursive: true });
  let cfg: any = {};
  if (cfgExists) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* 损坏则覆盖 */ }
  }
  if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents = {};
  cfg.agents[name] = {
    configPath: agentFile,
    kind: "local",
  };
  // 4. 若 defaultAgent 未设 → 设为 name
  let defaultSet = false;
  if (!cfg.defaultAgent) {
    cfg.defaultAgent = name;
    defaultSet = true;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  printJson({
    id: agentId,
    name,
    master: wsUrl,
    cliTool,
    workingDir,
    configFile: agentFile,
    defaultAgent: defaultSet ? name : "(unchanged)",
    hint: `验证: rotom whoami   # 应显示 ${name}`,
  });
}
