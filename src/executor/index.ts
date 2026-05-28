/**
 * Mesh Executor — 稳交付组 Agent 服务（多 Worker 架构）
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

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeExecutor } from "./executors/claude-code.js";
import { CodexExecutor } from "./executors/codex.js";
import { DeepseekCliExecutor } from "./executors/deepseek-cli.js";
import { GenericCliExecutor } from "./executors/generic-cli.js";
import { HermesCliExecutor } from "./executors/hermes-cli.js";
import { OpenclawExecutor } from "./executors/openclaw.js";
import type { CliExecutor } from "./cli-executor.js";
import { ExecutorWorker, type WorkerConfig } from "./worker.js";

// ── Config ──────────────────────────────────────────────────────────────

interface SingleWorkerConfig {
  master: string;
  name: string;
  token: string;
  cliTool?: string;
  profile?: {
    category?: string;
    position?: string;
    responsibilities?: string;
    tech_stack?: string;
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
      master: "ws://localhost:18800",
      workers: [
        {
          name: "稳交付·Claude",
          token: "mesh_xxx",
          cliTool: "claude",
          profile: { category: "稳交付组" },
        },
      ],
    }, null, 2),
  );
  process.exit(1);
}

// ── CLI tool detection ──────────────────────────────────────────────────

const CLI_PRIORITY = ["claude", "deepseek", "openclaw", "codex", "aider"];

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
    case "deepseek":
      return new DeepseekCliExecutor();
    case "hermes":
      return new HermesCliExecutor();
    case "openclaw":
      return new OpenclawExecutor();
    case "codex":
      return new CodexExecutor();
    default:
      return new GenericCliExecutor(tool);
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
}

const fallbackCli = detectCliTool();
const workerInstances: ExecutorWorker[] = [];

for (const w of workers) {
  const cliTool = w.cliTool || fallbackCli;
  const executor = createExecutor(cliTool);
  const worker = new ExecutorWorker(w, executor, master, cliTool);
  workerInstances.push(worker);
}

console.log(`[executor] Starting ${workerInstances.length} worker(s) (fallback cli: ${fallbackCli})`);

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
