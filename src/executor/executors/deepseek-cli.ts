/**
 * Deepseek CLI Executor
 *
 * Spawns `deepseek run -p <prompt>` as a child process.
 * Requires config: approval_policy=never, sandbox_mode=danger-full-access
 */

// TODO 只能回答问题，不能执行命令

import { spawn } from "node:child_process";
import type { CliExecutor, ExecuteOptions, ExecuteResult } from "../cli-executor.js";

export class DeepseekCliExecutor implements CliExecutor {
  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const args = [
        "run",
        "-p", prompt,
      ];

      console.log(`[deepseek-cli] Spawning deepseek run (cwd: ${workingDir})`);

      const proc = spawn("deepseek", args, {
        cwd: workingDir,
        env: { ...process.env, ...options?.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => {
        console.log(`[deepseek-cli] Aborted, killing pid=${proc.pid}`);
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
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
        const text = data.toString().trim();
        if (text && !text.startsWith("Warning:") && !text.startsWith("Note:")) {
          console.error(`[deepseek-cli] stderr: ${text}`);
        }
      });

      proc.on("close", (code) => {
        console.log(`[deepseek-cli] Exited code=${code}, output=${fullOutput.length} chars`);
        resolve({ exitCode: code ?? 1, fullOutput });
      });

      proc.on("error", (err) => {
        console.error(`[deepseek-cli] Spawn error: ${err.message}`);
        resolve({ exitCode: 1, fullOutput });
      });
    });
  }
}
