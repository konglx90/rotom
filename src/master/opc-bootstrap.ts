/**
 * OPC bootstrap — 首次启动时自动建立"个人 OPC"最小可用环境。
 *
 * Phase 1 的核心:让 `mesh-master` 一命令起来就是一个完整 OPC ——
 * 有本机 master 身份、有默认 agent(免 token)、有默认群。
 * 用户无需任何配置就能开箱即用,断网也能完整工作。
 *
 * 这个模块也是 Phase 2 federation 的接入点 —— 后续加 ensureLocalExecutor、
 * federation client 等都在这里挂。
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { generateShortId } from "../shared/short-id.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MeshDb } from "./db.js";
import type { MasterIdentity } from "./federation/identity.js";
import { REAL_PERSONS } from "../shared/protocol/enums.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("opc-bootstrap");

const __filename = fileURLToPath(import.meta.url);

export interface OpcBootstrapResult {
  /** masterId,与 identity.id 相同 */
  masterId: string;
  /** hostname,与 identity.hostname 相同 */
  hostname: string;
  /** role,与 identity.role 相同 */
  role: MasterIdentity["role"];
  /** 新建的默认 agent 信息(若 agents 表非空则为 undefined) */
  defaultAgent?: { id: string; name: string };
  /** 新建的默认 group 信息(若 groups 表非空则为 undefined) */
  defaultGroup?: { id: string; name: string };
  /** 回填 hostname 的 agent 行数(老数据 hostname IS NULL 的行) */
  backfilledAgents: number;
}

/**
 * 把 agents 表里 hostname 为 NULL 的行回填本机 hostname。
 * 这是 migration 055 的运行时补充 —— migration 跑的时候 master_node 表
 * 还没有身份行,SQL UPDATE 找不到 hostname 来源,所以放到 TS 层处理。
 */
export function backfillAgentsHostname(db: MeshDb, hostname: string): number {
  const result = db.db.prepare(
    "UPDATE agents SET hostname = ? WHERE hostname IS NULL",
  ).run(hostname);
  return result.changes;
}

/**
 * 若 agents 表为空,自动建一个默认 agent(免 token,靠本机信任认证)。
 * 已有 agent 时 no-op。
 *
 * name = os.userInfo().username(若命中 REAL_PERSONS 则标 category="真人")。
 */
export function ensureDefaultAgent(
  db: MeshDb,
  identity: MasterIdentity,
): { id: string; name: string } | null {
  const existing = db.listAgents();
  if (existing.length > 0) return null;

  const userInfo = os.userInfo();
  const name = userInfo.username || "default";
  const id = randomUUID();
  const isRealPerson = (REAL_PERSONS as readonly string[]).includes(name);
  const profile = JSON.stringify(isRealPerson ? { category: "真人" } : {});

  db.insertAgent({
    id,
    name,
    hostname: identity.hostname,
    tokenHash: "",
    token: "",
    profile,
  });

  log.info(`Created default agent "${name}" (hostname=${identity.hostname}${isRealPerson ? ", realPerson" : ""})`);
  return { id, name };
}

/**
 * 若无 group,创建 `Local` 默认群并把默认 agent 加进去。
 * 已有 group 时 no-op。
 */
export function ensureDefaultGroup(
  db: MeshDb,
  defaultAgentName?: string,
): { id: string; name: string } | null {
  const groups = db.listGroups();
  if (groups.length > 0) return null;

  const id = generateShortId();
  const name = "Local";
  db.createGroup(id, name, defaultAgentName);
  if (defaultAgentName) {
    db.addGroupMembers(id, [defaultAgentName]);
  }

  log.info(`Created default group "${name}"${defaultAgentName ? ` with member "${defaultAgentName}"` : ""}`);
  return { id, name };
}

/**
 * OPC bootstrap 完整流程:
 *   1. 写 master_node 身份行
 *   2. 回填 agents.hostname
 *   3. 默认 agent(若空)
 *   4. 默认 group(若空)
 *
 * 在 master 启动 main() 里 DB 初始化之后立即调用 —— 此处 mesh.db 已跑完
 * migration 054/055,master_node 表存在,可以安全写入。
 */
export function runOpcBootstrap(db: MeshDb, identity: MasterIdentity): OpcBootstrapResult {
  // teamName 兜底:如果用户没配 ROTOM_TEAM_NAME / master.json,查本机真人 agent
  // (profile.category="真人"),用其 name + "团队" 作默认(如"西花团队")。
  // 这是"每台机器 = 一个真人 + 一个团队"语义的体现:团队名跟随主理人。
  let teamName = identity.teamName;
  if (!teamName) {
    const agents = db.listAgents();
    const realPerson = agents.find((a) => {
      try {
        const p = a.profile ? JSON.parse(a.profile) as { category?: string } : {};
        return p.category === "真人";
      } catch {
        return false;
      }
    });
    if (realPerson) {
      teamName = `${realPerson.name}团队`;
      log.info(`Derived teamName from real-person agent: "${teamName}"`);
    }
  }
  if (!teamName) {
    // 最后兜底:用 hostname(避免 master_node.team_name 为 NULL)
    teamName = identity.hostname;
  }

  db.upsertMasterNode({
    id: identity.id,
    hostname: identity.hostname,
    role: identity.role,
    teamName,
  });

  const backfilledAgents = backfillAgentsHostname(db, identity.hostname);
  if (backfilledAgents > 0) {
    log.info(`Backfilled hostname=${identity.hostname} for ${backfilledAgents} agent row(s)`);
  }

  const defaultAgent = ensureDefaultAgent(db, identity);
  const defaultGroup = ensureDefaultGroup(db, defaultAgent?.name);

  log.info(`OPC ready: masterId=${identity.id} hostname=${identity.hostname} role=${identity.role}`);

  return {
    masterId: identity.id,
    hostname: identity.hostname,
    role: identity.role,
    defaultAgent: defaultAgent ?? undefined,
    defaultGroup: defaultGroup ?? undefined,
    backfilledAgents,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Local executor supervisor
// ────────────────────────────────────────────────────────────────────────────

export interface EnsureLocalExecutorOpts {
  rotomHome: string;
  masterPort: number;
  /** scanClis 模式用不到;defaultAgent 模式用作 .auto-executor.json 的兜底 agent 名 */
  defaultAgentName?: string;
}

export interface LocalExecutor {
  child: ChildProcess;
  /** 优雅停止:先 SIGTERM,5s 后 SIGKILL 兜底。 */
  stop: () => void;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * OPC 模式下由 master 自动拉起本机 executor 子进程,免去用户手动 nohup。
 *
 * 配置选择:
 *   - 用户已写 ~/.rotom/executor.config.json → 用它 spawn(尊重用户配置)
 *   - 否则生成 .auto-executor.json(token=null,走 isLoopback 信任)+ spawn
 *
 * 跳过 spawn 的条件:
 *   - ROTOM_FEDERATION_DISABLED=1(纯 standalone)
 *   - 已有 local-executor.pid 指向存活进程
 *
 * 子进程生命周期与 master 绑定:master 退出时自动 SIGTERM + 5s 后 SIGKILL。
 */
export function ensureLocalExecutor(opts: EnsureLocalExecutorOpts): LocalExecutor | null {
  const { rotomHome, masterPort, defaultAgentName } = opts;

  if (process.env.ROTOM_FEDERATION_DISABLED === "1") {
    log.info("ROTOM_FEDERATION_DISABLED=1 — skipping auto executor spawn");
    return null;
  }

  const runDir = path.join(rotomHome, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const pidFile = path.join(runDir, "local-executor.pid");
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (pid && isProcessAlive(pid)) {
        log.info(`Local executor already running (PID ${pid}) — skipping spawn`);
        return null;
      }
    }
  } catch { /* fallthrough to spawn */ }

  // 1. 选 config 路径:用户已配 executor.config.json → 用它;否则生成 .auto-executor.json
  //    .auto-executor.json 走 scanClis 模式 —— executor 启动时扫描本机已安装的
  //    claude/codex/hermes/pi,为每个 CLI 注册一个 agent(name 默认 = CLI 名)。
  const userConfigPath = path.join(rotomHome, "executor.config.json");
  const autoConfigPath = path.join(rotomHome, ".auto-executor.json");
  let configPath: string;
  if (fs.existsSync(userConfigPath)) {
    configPath = userConfigPath;
    log.info(`Using user config ${userConfigPath} for auto-spawned executor`);
  } else {
    const workspaceDir = path.join(rotomHome, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const autoConfig = {
      master: `ws://127.0.0.1:${masterPort}`,
      token: null,  // 本机信任模式
      scanClis: true,
      workingDir: workspaceDir,
    };
    fs.writeFileSync(autoConfigPath, JSON.stringify(autoConfig, null, 2) + "\n", "utf-8");
    configPath = autoConfigPath;
    log.info(`Generated ${autoConfigPath} (scanClis mode — executor will register one agent per installed CLI)`);
  }

  // 2. 定位 executor 入口:dist/master/X.js → dist/executor/index.js;src/master/X.ts → src/executor/index.ts
  const isTs = __filename.endsWith(".ts");
  const executorExt = isTs ? "ts" : "js";
  const executorPath = path.resolve(path.dirname(__filename), `../executor/index.${executorExt}`);
  if (!fs.existsSync(executorPath)) {
    log.warn(`Executor entry not found at ${executorPath} — skipping auto spawn`);
    return null;
  }

  // 3. 准备日志文件(stdio 重定向)
  const logDir = path.join(rotomHome, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.join(logDir, "local-executor.log");
  const logFd = fs.openSync(logFilePath, "a");

  // 4. spawn
  // ts 模式跑 tsx(走 Node 的 --import tsx 加载器);js 模式直接 node
  const args = isTs
    ? ["--import", "tsx", executorPath, "--config", configPath]
    : [executorPath, "--config", configPath];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ROTOM_HOME: rotomHome },
    detached: false,
  });
  fs.closeSync(logFd);  // 父进程关闭 fd,子进程已继承

  if (!child.pid) {
    log.error("Failed to spawn local executor");
    return null;
  }
  fs.writeFileSync(pidFile, String(child.pid), "utf-8");
  log.info(`Spawned local executor (PID ${child.pid}) — log: ${logFilePath}`);

  child.on("exit", (code, signal) => {
    log.info(`Local executor exited (code=${code} signal=${signal})`);
    try { fs.unlinkSync(pidFile); } catch { /* already removed */ }
  });

  const stop = (): void => {
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      log.info(`Stopping local executor (PID ${child.pid})...`);
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!child.killed && child.exitCode === null && child.signalCode === null) {
          log.warn(`Local executor (PID ${child.pid}) did not exit in 5s, sending SIGKILL`);
          child.kill("SIGKILL");
        }
      }, 5_000);
      child.once("exit", () => clearTimeout(killTimer));
    }
  };

  return { child, stop };
}
