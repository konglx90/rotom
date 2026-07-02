/**
 * Mesh Executor — Agent 服务（多 Worker 架构）
 *
 * 一个 executor 进程管理多个数字员工（worker），每个 worker 拥有：
 * - 独立身份（name/token/profile）
 * - 独立 WebSocket 连接
 * - 独立 CLI 后端（claude/codex/openclaw/...）
 * - 独立任务队列
 *
 * 配置向后兼容：单 worker 格式仍然可用。
 *
 * Usage:
 *   npx tsx src/executor/index.ts                                # 读 ~/.rotom/executor.config.json
 *   npx tsx src/executor/index.ts --config /path/to/config.json  # 显式指定
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeExecutor } from "./executors/claude-code.js";
import { CodexExecutor } from "./executors/codex.js";
import { HermesCliExecutor } from "./executors/hermes-cli.js";
import { OpenclawExecutor } from "./executors/openclaw.js";
import { PiExecutor } from "./executors/pi.js";
import type { CliExecutor } from "./cli-executor.js";
import { ExecutorWorker, type WorkerConfig } from "./worker.js";
import { SessionStore } from "./session-store.js";
import { ensureRotomSkillMd } from "../shared/skill-md.js";

// ── Config ──────────────────────────────────────────────────────────────

interface SingleWorkerConfig {
  master: string;
  name: string;
  token: string;
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

type ExecutorConfig = SingleWorkerConfig | MultiWorkerConfig;

const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const DEFAULT_CONFIG_PATH = path.join(ROTOM_HOME, "executor.config.json");

function loadConfig(): ExecutorConfig {
  const configIdx = process.argv.indexOf("--config");
  if (configIdx !== -1 && process.argv[configIdx + 1]) {
    const configPath = path.resolve(process.argv[configIdx + 1]);
    if (!fs.existsSync(configPath)) {
      console.error(`Config not found: ${configPath}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExecutorConfig;
  }

  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8")) as ExecutorConfig;
  }

  console.error(
    `No config found. Create ${DEFAULT_CONFIG_PATH}:\n` +
    JSON.stringify({
      master: "ws://localhost:28800",
      workers: [
        {
          name: "Claude·Agent",
          token: "mesh_xxx",
          cliTool: "claude",
        },
      ],
    }, null, 2),
  );
  process.exit(1);
}

// ── CLI tool detection ──────────────────────────────────────────────────

const CLI_PRIORITY = ["claude", "openclaw", "codex", "pi"];

function detectCliTool(): string {
  for (const tool of CLI_PRIORITY) {
    try {
      execSync(`which ${tool}`, { stdio: "pipe" });
      return tool;
    } catch { /* not found */ }
  }
  return "claude";
}

function createExecutor(tool: string): CliExecutor {
  switch (tool) {
    case "claude":
      return new ClaudeCodeExecutor();
    case "hermes":
      return new HermesCliExecutor();
    case "openclaw":
      return new OpenclawExecutor();
    case "codex":
      return new CodexExecutor();
    case "pi":
      return new PiExecutor();
    default:
      throw new Error(
        `Unknown cliTool "${tool}". Valid values: claude | codex | hermes | openclaw | pi. ` +
          `Configure one of these explicitly in executor.config.json (the previous generic passthrough has been removed — set a known tool to avoid silent misconfiguration).`,
      );
  }
}

// ── Normalize config to WorkerConfig[] ──────────────────────────────────

function normalizeWorkers(config: ExecutorConfig): { master: string; workers: WorkerConfig[] } {
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
  console.error("Config requires: master");
  process.exit(1);
}

if (workers.length === 0) {
  console.error("Config requires at least one worker");
  process.exit(1);
}

for (const w of workers) {
  if (!w.name || !w.token) {
    console.error(`Worker requires: name, token (got: ${JSON.stringify({ name: w.name, token: w.token ? "***" : undefined })})`);
    process.exit(1);
  }
  // workingDir 必填 + 存在性 + 可读性校验
  // 跨机器部署时该路径必须存在于 executor 本地 FS,与 master 无关
  if (!w.workingDir) {
    console.error(`[executor] worker "${w.name}" missing required "workingDir" in executor.config.json — agent needs a local project dir to read. Aborting.`);
    process.exit(1);
  }
  if (!fs.existsSync(w.workingDir)) {
    console.error(`[executor] worker "${w.name}" workingDir "${w.workingDir}" does not exist on this machine. Aborting.`);
    process.exit(1);
  }
  try {
    fs.accessSync(w.workingDir, fs.constants.R_OK);
  } catch {
    console.error(`[executor] worker "${w.name}" workingDir "${w.workingDir}" is not readable. Aborting.`);
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
  console.log(`[executor] worker "${w.name}" base cwd: ${w.workingDir} (per-group: <base>/<groupId>${mapCount > 0 ? `, ${mapCount} explicit override(s)` : ""})`);
}

console.log(`[executor] Starting ${workerInstances.length} worker(s) (fallback cli: ${fallbackCli})`);

// 启动时把 SKILL.md 落到 ~/.rotom/。幂等(内容相同则跳过),best-effort。
ensureRotomSkillMd();

for (const worker of workerInstances) {
  worker.start();
}

// Graceful shutdown
function shutdown(): void {
  console.log(`[executor] Shutting down ${workerInstances.length} worker(s)...`);
  for (const worker of workerInstances) {
    worker.stop();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
