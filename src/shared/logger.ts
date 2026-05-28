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
 *   enableFileLogging("~/.openclaw/logs");        // enable file output
 *   log.info("with file");                        // → stdout + logs/mesh-master-2026-03-23.log
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

// ---------------------------------------------------------------------------
// File logging state (shared across all loggers in this process)
// ---------------------------------------------------------------------------

let logDir: string | null = null;
let currentDate = "";
let currentFd: number | null = null;
const LOG_RETAIN_DAYS = 30;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // "2026-03-23"
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
      if (!name.startsWith("mesh-master-") || !name.endsWith(".log")) continue;
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
 * will also write to `{dir}/mesh-master-YYYY-MM-DD.log`.
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
  return new Date().toISOString();
}

/** Create a logger with a module prefix, e.g. createLogger("mesh-master") */
export function createLogger(module: string): Logger {
  const tag = `[${module}]`;

  function emit(level: string, consoleFn: (...a: unknown[]) => void, args: unknown[]): void {
    const timestamp = ts();
    const line = `${timestamp} ${level} ${tag} ${format(...args)}`;
    consoleFn(timestamp, level, tag, ...args);
    writeToFile(line);
  }

  return {
    log:   (...args) => emit("INFO",  console.log,   args),
    info:  (...args) => emit("INFO",  console.log,   args),
    warn:  (...args) => emit("WARN",  console.warn,  args),
    error: (...args) => emit("ERROR", console.error, args),
  };
}
