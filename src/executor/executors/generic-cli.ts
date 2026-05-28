/**
 * Generic CLI Executor
 *
 * A fallback executor that wraps any CLI command (e.g., `codex`, `aider`)
 * with simple stdout streaming. Does not parse structured output — just
 * passes through raw text.
 */

import { spawn } from "node:child_process";
import type { CliExecutor, ExecuteOptions, ExecuteResult } from "../cli-executor.js";

export class GenericCliExecutor implements CliExecutor {
  constructor(private command: string) {}

  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const proc = spawn(this.command, [prompt], {
        cwd: workingDir,
        env: { ...process.env, ...options?.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const onAbort = () => {
        console.log(`[generic-cli:${this.command}] Aborted, killing pid=${proc.pid}`);
        try { proc.kill("SIGTERM"); } catch { /* noop */ }
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* noop */ } }, 3_000);
      };
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      let fullOutput = "";

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        fullOutput += text;
        onOutput(text);
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        fullOutput += text;
        onOutput(text);
      });

      proc.on("close", (code) => {
        resolve({ exitCode: code ?? 1, fullOutput });
      });

      proc.on("error", (err) => {
        onOutput(`[error] Failed to spawn ${this.command}: ${err.message}`);
        resolve({ exitCode: 1, fullOutput });
      });
    });
  }
}
