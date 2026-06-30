/**
 * rotom join — 首次申请 token 落盘到 ~/.rotom/
 *
 * 给"本地交互式 codex 作为 mesh host"模式用:本机不跑 executor daemon,
 * codex 直接通过 Bash 调 rotom CLI 与 mesh 交互。本命令一次性完成:
 *   1. POST http://<master>/api/agents { name, domain } → 拿到 plaintext token + configTemplate
 *   2. 落盘 configTemplate 到 ~/.rotom/agents/<name>.json(resolveAgentFromEntry 直接能读)
 *   3. 在 ~/.rotom/config.json 的 agents[name] 注册一条 { configPath, kind: "openclaw" }
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
  return { host, port, httpUrl: `http://${host}:${port}`, wsUrl: `ws://${host}:${port}` };
}

export async function cmdJoin(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const masterSpec = rest[0];
  if (!masterSpec) {
    fail(
      "usage: rotom join <masterHost:port> --name <agentName> --domain <domain> [--force]\n" +
      "  首次申请 token 落盘到 ~/.rotom/。之后 `rotom --as <name> ...` 自动解出 master+token。",
    );
  }
  const name = flagStr(flags, "name");
  const domain = flagStr(flags, "domain");
  if (!name) fail("--name is required (the agent name you want to register on master)");
  if (!domain) fail("--domain is required (use an existing domain on master; see dashboard)");
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
  let resp: Response;
  try {
    resp = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, domain }),
    });
  } catch (e) {
    fail(`failed to reach master at ${httpUrl}: ${(e as Error).message}\n  run \`rotom status\` to verify reachability`);
  }
  const text = await resp.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const detail = typeof data === "object" && data?.error ? data.error : text;
    fail(`master rejected agent registration (HTTP ${resp.status}): ${detail}`);
  }
  const token: string | undefined = data?.token;
  const agentId: string | undefined = data?.id;
  if (!token || !agentId) {
    fail(`master did not return token/id in registration response: ${text}`);
  }

  // 2. 落盘 configTemplate(即 openclaw.json 格式)到 ~/.rotom/agents/<name>.json
  const agentsDir = path.join(ROTOM_HOME, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentFile = path.join(agentsDir, `${name}.json`);
  // 优先用 master 返回的 configTemplate(已含正确 master URL + token + name),
  // 兜底自构(老版本 master 可能不返回 configTemplate)。
  const agentConfig = data.configTemplate ?? {
    channels: {
      "a2a-gateway": {
        master: wsUrl,
        name,
        token,
      },
    },
  };
  fs.writeFileSync(agentFile, JSON.stringify(agentConfig, null, 2));

  // 3. 写 ~/.rotom/config.json 的 agents[name] = { configPath, kind: "openclaw" }
  fs.mkdirSync(ROTOM_HOME, { recursive: true });
  let cfg: any = {};
  if (cfgExists) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch { /* 损坏则覆盖 */ }
  }
  if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents = {};
  cfg.agents[name] = {
    configPath: agentFile,
    kind: "openclaw",
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
    configFile: agentFile,
    defaultAgent: defaultSet ? name : "(unchanged)",
    hint: `验证: rotom whoami   # 应显示 ${name}`,
  });
}
