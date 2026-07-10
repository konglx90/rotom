/**
 * Mesh Executor — Agent 服务（多 Worker 架构）
 *
 * 一个 executor 进程管理多个数字员工（worker），每个 worker 拥有：
 * - 独立身份（name/token/profile）
 * - 独立 WebSocket 连接
 * - 独立 CLI 后端（claude/codex/...）
 * - 独立任务队列
 *
 * 配置向后兼容：单 worker 格式仍然可用。
 *
 * Usage:
 *   npx tsx src/executor/index.ts                                # 读 ~/.rotom/executor.config.json
 *   npx tsx src/executor/index.ts --config /path/to/config.json  # 显式指定
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeExecutor } from "./executors/claude-code.js";
import { CodexExecutor } from "./executors/codex.js";
import { HermesCliExecutor } from "./executors/hermes-cli.js";
import { PiExecutor } from "./executors/pi.js";
import type { CliExecutor } from "./cli-executor.js";
import { ExecutorWorker, type WorkerConfig } from "./worker.js";
import { SessionStore } from "./session-store.js";
import { ensureRotomSkillMd } from "../shared/skill-md.js";
import { createLogger } from "../shared/logger.js";
import { detectCliTool, detectInstalledClis } from "../shared/cli-detect.js";

const log = createLogger("mesh-executor", { stream: "stderr" });

// ── Config ──────────────────────────────────────────────────────────────

interface SingleWorkerConfig {
  master: string;
  name: string;
  /** OPC 本机模式下可省略 —— master 端 isLoopback 命中时走 authenticateLocal。 */
  token?: string;
  cliTool?: string;
  profile?: {
    category?: string;
    position?: string;
    bio?: string;
  };
  workingDir?: string;
  maxConcurrent?: number;
}

interface MultiWorkerConfig {
  master: string;
  workers: WorkerConfig[];
}

/**
 * `.auto-executor.json` 是 master 在 OPC 模式下自动生成的 executor 配置。
 *
 * 两种形态:
 *   1. defaultAgent 显式指定 → 单 worker(向后兼容旧 .auto-executor.json)
 *   2. scanClis=true → executor 扫描本机已安装的 claude/codex/hermes/pi,
 *      为每个 CLI 注册一个 agent(name 默认 = CLI 名;用户可在 executor.config.json
 *      里给 agent 起别名覆盖)。这是"每台机器 = 一个真人 + 多个 CLI agent"语义。
 */
interface AutoExecutorConfig {
  master: string;
  token?: string | null;
  /** 标示进入 CLI 扫描模式;defaultAgent 与 scanClis 互斥 */
  scanClis?: boolean;
  defaultAgent?: {
    name: string;
    hostname?: string;
    cliTool?: string;
    profile?: SingleWorkerConfig["profile"];
  };
  workingDir?: string;
}

type ExecutorConfig = SingleWorkerConfig | MultiWorkerConfig;

const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const DEFAULT_CONFIG_PATH = path.join(ROTOM_HOME, "executor.config.json");
const AUTO_CONFIG_PATH = path.join(ROTOM_HOME, ".auto-executor.json");

function loadConfig(): ExecutorConfig {
  // 优先级:CLI --config > 用户配置 executor.config.json > master 自动生成 .auto-executor.json
  const configIdx = process.argv.indexOf("--config");
  if (configIdx !== -1 && process.argv[configIdx + 1]) {
    const configPath = path.resolve(process.argv[configIdx + 1]);
    if (!fs.existsSync(configPath)) {
      log.error(`Config not found: ${configPath}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExecutorConfig;
  }

  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8")) as ExecutorConfig;
  }

  if (fs.existsSync(AUTO_CONFIG_PATH)) {
    const auto = JSON.parse(fs.readFileSync(AUTO_CONFIG_PATH, "utf-8")) as AutoExecutorConfig;
    log.info(`Loaded auto-config from ${AUTO_CONFIG_PATH} (OPC mode, token optional)`);
    if (auto.scanClis) {
      // CLI 扫描模式:为每个本机已安装的 CLI 起一个 worker。
      const installed = detectInstalledClis();
      if (installed.length === 0) {
        log.error("scanClis=true but no known CLI (claude/codex/hermes/pi) found in PATH");
        process.exit(1);
      }
      return {
        master: auto.master,
        workers: installed.map(cli => ({
          name: cli,
          cliTool: cli,
          workingDir: auto.workingDir,
        })),
      } satisfies MultiWorkerConfig;
    }
    if (!auto.defaultAgent) {
      log.error(`${AUTO_CONFIG_PATH} missing defaultAgent or scanClis — invalid OPC config`);
      process.exit(1);
    }
    return {
      master: auto.master,
      name: auto.defaultAgent.name,
      // token 可能为 null(本机信任模式),undefined 比 null 更干净
      token: auto.token ?? undefined,
      cliTool: auto.defaultAgent.cliTool,
      profile: auto.defaultAgent.profile,
      workingDir: auto.workingDir,
    };
  }

  log.error(
    `No config found. Either:\n` +
    `  1. Run mesh-master (it auto-spawns a local executor in OPC mode), or\n` +
    `  2. Create ${DEFAULT_CONFIG_PATH}:\n` +
    JSON.stringify({
      master: "ws://localhost:28800",
      workers: [
        { name: "Claude·Agent", token: "mesh_xxx", cliTool: "claude", workingDir: "/path/to/project" },
      ],
    }, null, 2),
  );
  process.exit(1);
}

// ── CLI tool detection ──────────────────────────────────────────────────

// detectCliTool / detectInstalledClis 已抽到 src/shared/cli-detect.ts,CLI 侧 resolveAgent 也共用。

function createExecutor(tool: string): CliExecutor {
  switch (tool) {
    case "claude":
      return new ClaudeCodeExecutor();
    case "hermes":
      return new HermesCliExecutor();
    case "codex":
      return new CodexExecutor();
    case "pi":
      return new PiExecutor();
    default:
      throw new Error(
        `Unknown cliTool "${tool}". Valid values: claude | codex | hermes | pi. ` +
          `Configure one of these explicitly in executor.config.json (the previous generic passthrough has been removed — set a known tool to avoid silent misconfiguration).`,
      );
  }
}

// ── Normalize config to WorkerConfig[] ──────────────────────────────────

function normalizeWorkers(config: ExecutorConfig): { master: string; workers: WorkerConfig[] } {
  // 兼容 .auto-executor.json 格式(由 master ensureLocalExecutor 生成):
  // 该格式有 defaultAgent 字段,无顶层 name/token。统一在这里转换,无论配置
  // 是从 CLI --config、executor.config.json 还是 .auto-executor.json 读来的。
  const maybeAuto = config as unknown as Partial<AutoExecutorConfig> & Record<string, unknown>;
  // scanClis 模式:扫本机 CLI,每个一个 worker
  if (maybeAuto.scanClis === true) {
    const auto = maybeAuto as AutoExecutorConfig;
    const installed = detectInstalledClis();
    if (installed.length === 0) {
      log.error("scanClis=true but no known CLI (claude/codex/hermes/pi) found in PATH");
      process.exit(1);
    }
    return {
      master: auto.master,
      workers: installed.map(cli => ({
        name: cli,
        cliTool: cli,
        workingDir: auto.workingDir,
      })),
    };
  }
  if (maybeAuto.defaultAgent && typeof maybeAuto.defaultAgent === "object") {
    const auto = maybeAuto as AutoExecutorConfig;
    const da = auto.defaultAgent!;
    return {
      master: auto.master,
      workers: [{
        name: da.name,
        token: auto.token ?? undefined,
        cliTool: da.cliTool,
        profile: da.profile,
        workingDir: auto.workingDir,
      }],
    };
  }

  if ("workers" in config && Array.isArray(config.workers)) {
    return { master: config.master, workers: config.workers };
  }
  // Single worker backward compatibility
  const single = config as SingleWorkerConfig;
  return {
    master: single.master,
    workers: [{
      name: single.name,
      token: single.token,
      cliTool: single.cliTool,
      profile: single.profile,
      workingDir: single.workingDir,
      maxConcurrent: single.maxConcurrent,
    }],
  };
}

// ── Main ────────────────────────────────────────────────────────────────

const config = loadConfig();
const { master, workers } = normalizeWorkers(config);

if (!master) {
  log.error("Config requires: master");
  process.exit(1);
}

if (workers.length === 0) {
  log.error("Config requires at least one worker");
  process.exit(1);
}

for (const w of workers) {
  if (!w.name) {
    log.error(`Worker requires: name (got: ${JSON.stringify({ name: w.name })})`);
    process.exit(1);
  }
  if (!w.token) {
    // OPC 模式下 token 可空 —— 走 master 端 isLoopback 信任。
    // 但远程连接(用户配 ws://remote)时空 token 必失败,提示一下。
    const isLoopbackMaster = /^wss?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?(\/|$)/.test(master);
    if (isLoopbackMaster) {
      log.info(`worker "${w.name}" has no token — relying on master loopback trust`);
    } else {
      log.warn(`worker "${w.name}" has no token but master is remote (${master}) — auth will likely fail`);
    }
  }
  // workingDir 必填 + 存在性 + 可读性校验
  // 跨机器部署时该路径必须存在于 executor 本地 FS,与 master 无关
  if (!w.workingDir) {
    log.error(`worker "${w.name}" missing required "workingDir" in executor.config.json — agent needs a local project dir to read. Aborting.`);
    process.exit(1);
  }
  if (!fs.existsSync(w.workingDir)) {
    log.error(`worker "${w.name}" workingDir "${w.workingDir}" does not exist on this machine. Aborting.`);
    process.exit(1);
  }
  try {
    fs.accessSync(w.workingDir, fs.constants.R_OK);
  } catch {
    log.error(`worker "${w.name}" workingDir "${w.workingDir}" is not readable. Aborting.`);
    process.exit(1);
  }
}

const fallbackCli = detectCliTool();
const workerInstances: ExecutorWorker[] = [];

// 进程级共享 SessionStore —— 所有 worker 共用同一份内存 map。持久化在 master
// DB 的 agent_sessions 表里,worker 启动时通过 session_sync_push 从 master 拉。
const sharedSessions = new SessionStore();
// 一次性迁移:把旧的 ~/.rotom/sessions.json 灌进内存,auth_ok 后会推给 master
// 落 DB。文件读完即删,后续启动直接走 master DB。
sharedSessions.backfillFromLegacyJson(ROTOM_HOME);

for (const w of workers) {
  const cliTool = w.cliTool || fallbackCli;
  const executor = createExecutor(cliTool);
  // 第 5 个参数 rotomHome:SessionStore 文件落点,与 per-group cwd 派生路径解耦;
  // 第 6 个参数 sharedSessions:进程级单例,所有 worker 共用。
  const worker = new ExecutorWorker(w, executor, master, cliTool, ROTOM_HOME, sharedSessions);
  workerInstances.push(worker);
  const mapCount = w.workingDirMap ? Object.keys(w.workingDirMap).length : 0;
  log.info(`worker "${w.name}" base cwd: ${w.workingDir} (per-group: <base>/<groupId>${mapCount > 0 ? `, ${mapCount} explicit override(s)` : ""})`);
}

log.info(`Starting ${workerInstances.length} worker(s) (fallback cli: ${fallbackCli})`);

// 启动时把 SKILL.md 落到 ~/.rotom/。幂等(内容相同则跳过),best-effort。
ensureRotomSkillMd();

for (const worker of workerInstances) {
  worker.start();
}

// Graceful shutdown
function shutdown(): void {
  log.info(`Shutting down ${workerInstances.length} worker(s)...`);
  for (const worker of workerInstances) {
    worker.stop();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
