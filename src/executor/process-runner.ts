/**
 * Process lifecycle helper for CLI executors.
 *
 * Every CLI executor (claude-code / codex / hermes-cli / openclaw) repeats
 * the same dance:
 *   1. spawn(bin, args, { cwd, env, stdio: ["pipe","pipe","pipe"] })
 *   2. on AbortSignal → kill SIGTERM, then SIGKILL after 3s
 *   3. resolve on `close`, resolve(error=1) on `error`
 *   4. emit a Spawning/Exited log line with a label
 *
 * This module centralizes that pattern so the executors only carry the
 * protocol-specific line-parsing logic on top. Executors retain ownership
 * of `proc.stdin.write/end` and the stdout/stderr listener wiring.
 *
 * The return type is `ChildProcessByStdio<Writable, Readable, Readable>` so
 * callers can attach `.on("data", ...)` to `proc.stdout` / `proc.stderr` and
 * `proc.stdin.write(...)` without non-null assertions. We cast to the typed
 * spawn signature internally — all 4 executors actually use
 * `["pipe","pipe","pipe"]` (openclaw's variant is also piped), so this is
 * safe in practice.
 */

import { spawn, type ChildProcessByStdio, type StdioPipe } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-executor-process-runner", { stream: "stderr" });

export interface ProcessRunnerOptions {
  /** Binary to invoke (PATH-resolved by node:child_process). */
  bin: string;
  /** Argument vector. */
  args: string[];
  /** Working directory passed to spawn(). */
  cwd: string;
  /** Extra env vars merged on top of process.env. Values must be strings. */
  env?: Record<string, string>;
  /**
   * stdio tuple. Default: `["pipe","pipe","pipe"]`. All 4 current executors
   * use piped stdio (openclaw's variant is also piped via `["ignore","pipe","pipe"]`,
   * but the caller can override if needed — the returned `proc` type assumes
   * full piping).
   */
  stdio?: [StdioPipe, StdioPipe, StdioPipe];
  /** Label used in log lines, e.g. `[codex]`. */
  label: string;
  /** AbortSignal — when triggered the runner kills the child (TERM → 3s → KILL). */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms. After this elapses, the child is SIGKILLed. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL. Default: 3000. */
  graceMs?: number;
}

export interface ProcessRunnerHandle {
  /** The underlying child_process. Callers attach stdout/stderr/stdin listeners. */
  proc: ChildProcessByStdio<Writable, Readable, Readable>;
  /**
   * Resolves when the process exits cleanly (`close`) or fails to spawn
   * (`error`). Never rejects — `exitCode` is the truth signal (1 on spawn
   * failure or non-zero exit).
   */
  done: Promise<{ exitCode: number; signal: NodeJS.Signals | null }>;
  /** Synchronously fire the abort sequence (SIGTERM → graceMs → SIGKILL). */
  abort: (reason?: string) => void;
}

/**
 * Spawn a long-running CLI process and wire up the abort/timeout/close
 * sequence shared by every executor.
 *
 * The returned `proc` is fully owned by the caller — they can attach
 * stdout/stderr listeners and write to stdin. The handle just owns the
 * lifecycle (abort + done).
 */
export function runProcess(opts: ProcessRunnerOptions): ProcessRunnerHandle {
  const graceMs = opts.graceMs ?? 3000;
  const stdio: [StdioPipe, StdioPipe, StdioPipe] = opts.stdio ?? ["pipe", "pipe", "pipe"];

  log.info(opts.label, "Spawning", opts.bin, `(cwd: ${opts.cwd}, args: ${opts.args.join(" ")})`);

  const proc = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio,
  });

  let killedByAbort = false;

  const killHard = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };

  const killGraceful = () => {
    if (proc.killed || proc.exitCode != null) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(killHard, graceMs).unref();
  };

  const abort = (reason?: string) => {
    if (killedByAbort) return;
    killedByAbort = true;
    log.info(opts.label, `Aborted${reason ? `: ${reason}` : ""}, killing pid=${proc.pid}`);
    killGraceful();
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      abort("signal already aborted");
    } else {
      opts.signal.addEventListener("abort", () => abort("signal"), { once: true });
    }
  }

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs) {
    timeoutTimer = setTimeout(() => {
      log.info(opts.label, `Timeout ${opts.timeoutMs}ms exceeded, killing pid=${proc.pid}`);
      killHard();
    }, opts.timeoutMs);
    timeoutTimer.unref();
  }

  const done = new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>(
    (resolve) => {
      proc.on("close", (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const exitCode = code ?? (killedByAbort ? 1 : 0);
        log.info(opts.label, `Exited code=${exitCode}${signal ? ` signal=${signal}` : ""}`);
        resolve({ exitCode, signal });
      });
      proc.on("error", (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        log.error(opts.label, "Spawn error:", err.message);
        resolve({ exitCode: 1, signal: null });
      });
    },
  );

  return { proc, done, abort };
}
