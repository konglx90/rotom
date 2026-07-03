import { nowBeijing } from "./time.js";
/**
 * Digital Employee Mesh — Logger
 *
 * Lightweight structured logger with timestamps. No external dependencies.
 * Supports optional daily-rotated file output with auto-cleanup.
 *
 * Usage:
 *   const log = createLogger("mesh-master");
 *   log.info("started");                         // → stdout only
 *
 *   enableFileLogging("~/.rotom/logs");        // enable file output
 *   log.info("with file");                        // → stdout + logs/mesh-master-2026-03-23.log
 *
 * Stream selection:
 *   - `createLogger("mesh-master")`             → default: info/log to stdout, warn/error to stderr
 *   - `createLogger("mesh-executor", { stream: "stderr" })` → all levels to stderr
 *     (use this in executor so log lines never pollute stdout, which keeps
 *     stdout free for any machine-parsed output the master might consume)
 *
 * The file-name prefix is derived from the module name passed to
 * createLogger — `createLogger("mesh-executor")` writes to
 * `mesh-executor-YYYY-MM-DD.log` (not `mesh-master-...`).
 */

import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

export interface Logger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type LoggerStream = "stdout" | "stderr" | "default";

export interface CreateLoggerOptions {
  /**
   * Force every level through a single stream. `"default"` (the default)
   * routes info/log to stdout and warn/error to stderr — preserves the
   * historical master behaviour. `"stderr"` routes every level to stderr —
   * used by the executor so stdout stays clean for machine-parsed output.
   */
  stream?: LoggerStream;
}

// ---------------------------------------------------------------------------
// File logging state (shared across all loggers in this process)
// ---------------------------------------------------------------------------

let logDir: string | null = null;
let currentDate = "";
let currentFd: number | null = null;
const LOG_RETAIN_DAYS = 30;

function todayStr(): string {
  return nowBeijing().slice(0, 10); // "2026-03-23"
}

function ensureFd(): number | null {
  if (!logDir) return null;

  const today = todayStr();
  if (today !== currentDate) {
    // Day changed — rotate
    if (currentFd !== null) {
      try { fs.closeSync(currentFd); } catch { /* ignore */ }
    }
    currentDate = today;
    const filePath = path.join(logDir, `mesh-master-${today}.log`);
    currentFd = fs.openSync(filePath, "a");
  }
  return currentFd;
}

function writeToFile(line: string): void {
  const fd = ensureFd();
  if (fd !== null) {
    try { fs.writeSync(fd, line + "\n"); } catch { /* non-fatal */ }
  }
}

function cleanupOldLogs(): void {
  if (!logDir) return;
  try {
    const cutoff = Date.now() - LOG_RETAIN_DAYS * 86_400_000;
    for (const name of fs.readdirSync(logDir)) {
      if (!name.startsWith("mesh-") || !name.endsWith(".log")) continue;
      const filePath = path.join(logDir, name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable daily-rotated file logging. All loggers created via createLogger()
 * will also write to `{dir}/{module}-YYYY-MM-DD.log`.
 * Old log files (>30 days) are cleaned up on enable.
 */
export function enableFileLogging(dir: string): void {
  const resolved = dir.startsWith("~")
    ? dir.replace("~", process.env.HOME || "")
    : dir;
  fs.mkdirSync(resolved, { recursive: true });
  logDir = resolved;
  currentDate = "";   // force re-open
  currentFd = null;
  cleanupOldLogs();
}

/** Flush and close file logging (for graceful shutdown). */
export function closeFileLogging(): void {
  if (currentFd !== null) {
    try { fs.closeSync(currentFd); } catch { /* ignore */ }
    currentFd = null;
  }
  logDir = null;
}

function ts(): string {
  return nowBeijing();
}

/** Create a logger with a module prefix, e.g. createLogger("mesh-master") */
export function createLogger(module: string, opts?: CreateLoggerOptions): Logger {
  const tag = `[${module}]`;
  const stream = opts?.stream ?? "default";

  function emit(level: string, consoleFn: (...a: unknown[]) => void, args: unknown[]): void {
    const timestamp = ts();
    const line = `${timestamp} ${level} ${tag} ${format(...args)}`;
    consoleFn(timestamp, level, tag, ...args);
    writeToFile(line);
  }

  // For "stderr" mode, every level writes to process.stderr; otherwise
  // the default mapping is info/log → console.log (stdout), warn → console.warn
  // (stderr), error → console.error (stderr).
  const outFn = stream === "stderr" ? console.error : console.log;
  const warnFn = stream === "stderr" ? console.error : console.warn;
  const errFn = console.error;

  return {
    log:   (...args) => emit("INFO",  outFn,  args),
    info:  (...args) => emit("INFO",  outFn,  args),
    warn:  (...args) => emit("WARN",  warnFn, args),
    error: (...args) => emit("ERROR", errFn,  args),
  };
}
