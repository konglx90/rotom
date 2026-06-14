/**
 * OpenClaw CLI Executor
 *
 * Spawns `openclaw agent --local --json --session-id <id> --message <prompt>`
 * and parses its output. Mirrors Multica's Go reference implementation in
 * server/pkg/agent/openclaw.go.
 *
 * OpenClaw output protocol:
 *   • Streaming NDJSON events (one of stdout/stderr depending on version)
 *       - { type: "text", text }
 *       - { type: "tool_use", tool, callId, input }
 *       - { type: "tool_result", tool, callId, text }
 *       - { type: "error", text | message | error }
 *       - { type: "lifecycle", phase: "error"|"failed"|"cancelled", ... }
 *       - { type: "step_start" } / { type: "step_finish", usage }
 *       - All events may carry a sessionId field.
 *   • Legacy single-blob result (pretty-printed multi-line JSON)
 *       { payloads: [{ text }], meta: { agentMeta: { sessionId, model, usage } } }
 *
 * Output stream: openclaw < 2026.5.5 writes the --json result to stderr;
 * 2026.5.5+ writes it to stdout (PR #2101). We read both streams and parse
 * whichever carries JSON — non-JSON lines are filtered as log noise.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliExecutor, ExecuteOptions, ExecuteResult } from "../cli-executor.js";
import { emitStatus } from "../reasoning-status.js";

interface OpenclawEvent {
  type?: string;
  sessionId?: string;
  text?: string;
  tool?: string;
  callId?: string;
  input?: unknown;
  usage?: Record<string, unknown>;
  phase?: string;
  message?: string;
  error?: {
    name?: string;
    message?: string;
    data?: { message?: string };
  };
}

interface OpenclawResult {
  payloads?: Array<{ text?: string }>;
  meta?: {
    durationMs?: number;
    agentMeta?: Record<string, unknown>;
  };
}

export class OpenclawExecutor implements CliExecutor {
  constructor(private agentName?: string) {}

  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const resumeSessionId = options?.sessionId;
      const sessionId = resumeSessionId || `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // prompt 已经由 worker 用 composePrompt() 拼好,executor 不再二次包装。

      const args = [
        "agent",
        "--local",
        "--json",
        "--session-id", sessionId,
      ];
      if (this.agentName) {
        args.push("--agent", this.agentName);
      }
      args.push("--message", prompt);

      const spawnEnv = { ...process.env, ...options?.env };
      console.log(`[openclaw] Spawning openclaw agent (cwd: ${workingDir}, session: ${sessionId}, agent: ${this.agentName ?? "(default)"})`);

      const proc = spawn("openclaw", args, {
        cwd: workingDir,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => {
        console.log(`[openclaw] Aborted, killing pid=${proc.pid}`);
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* noop */ } }, 3_000);
      };
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      let fullOutput = "";
      let emittedSessionId = "";
      let failed = false;
      let gotEvents = false;
      const rawLines: string[] = [];
      let stdoutBuffer = "";
      let stderrBuffer = "";

      function handleEvent(event: OpenclawEvent): boolean {
        if (!event.type) return false;
        gotEvents = true;
        if (event.sessionId) emittedSessionId = event.sessionId;

        switch (event.type) {
          case "text":
            if (event.text) {
              fullOutput += event.text;
              onOutput(event.text);
              emitStatus(onOutput, "Working");
            }
            return true;
          case "tool_use":
            onOutput(`[tool:exec]${JSON.stringify(event.input ?? {})}[/tool:exec]\n`);
            emitStatus(onOutput, "Running");
            return true;
          case "tool_result":
            if (event.text) {
              const truncated = event.text.length > 500
                ? `${event.text.slice(0, 500)}...`
                : event.text;
              onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
            }
            emitStatus(onOutput, "Done");
            return true;
          case "error": {
            const msg = extractErrorMessage(event);
            console.error(`[openclaw] error event: ${msg}`);
            onOutput(`[error] ${msg}\n`);
            failed = true;
            emitStatus(onOutput, "Failed");
            return true;
          }
          case "lifecycle": {
            const phase = event.phase ?? "";
            if (phase === "error" || phase === "failed" || phase === "cancelled") {
              const msg = extractErrorMessage(event);
              console.error(`[openclaw] lifecycle ${phase}: ${msg}`);
              onOutput(`[lifecycle:${phase}] ${msg}\n`);
              failed = true;
              emitStatus(onOutput, "Failed");
            }
            return true;
          }
          case "step_start":
            emitStatus(onOutput, "Working");
            return true;
          case "step_finish":
            emitStatus(onOutput, "Answered");
            return true;
          default:
            return false;
        }
      }

      function handleResultBlob(result: OpenclawResult): boolean {
        const payloads = result.payloads;
        const meta = result.meta;
        if (!payloads && !meta?.durationMs) return false;
        gotEvents = true;

        if (Array.isArray(payloads)) {
          for (const p of payloads) {
            if (p?.text) {
              fullOutput += p.text;
              onOutput(p.text);
            }
          }
        }

        const agentMeta = meta?.agentMeta;
        if (agentMeta && typeof agentMeta.sessionId === "string") {
          emittedSessionId = agentMeta.sessionId;
        }
        return true;
      }

      function handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed[0] !== "{") {
          rawLines.push(trimmed);
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          rawLines.push(trimmed);
          return;
        }

        const obj = parsed as OpenclawEvent & OpenclawResult;
        if (obj.type && handleEvent(obj)) return;
        if (handleResultBlob(obj)) return;
        rawLines.push(trimmed);
      }

      proc.stdout!.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          handleLine(line);
        }
      });

      // openclaw < 2026.5.5 writes its --json output to stderr; newer builds
      // write to stdout. Feed stderr through the same parser — log overflow
      // (non-JSON lines) is harmlessly collected in rawLines and only used
      // when no streaming events were parsed.
      proc.stderr!.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
        let idx: number;
        while ((idx = stderrBuffer.indexOf("\n")) !== -1) {
          const line = stderrBuffer.slice(0, idx);
          stderrBuffer = stderrBuffer.slice(idx + 1);
          // Strip ANSI color codes so JSON detection isn't fooled by escapes.
          handleLine(line.replace(/\x1b\[[0-9;]*m/g, ""));
        }
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
        if (stderrBuffer.trim()) handleLine(stderrBuffer.replace(/\x1b\[[0-9;]*m/g, ""));

        // No streaming events parsed — try the joined raw output as a pretty-
        // printed result blob. Mirrors the Go fallback path.
        if (!gotEvents && rawLines.length > 0) {
          const candidates: string[] = [];
          const joined = rawLines.join("\n").trim();
          if (joined.startsWith("{")) candidates.push(joined);
          for (let i = 0; i < rawLines.length; i++) {
            if (rawLines[i].startsWith("{")) {
              candidates.push(rawLines.slice(i).join("\n").trim());
              break;
            }
          }
          for (const candidate of candidates) {
            try {
              const parsed = JSON.parse(candidate) as OpenclawResult;
              if (handleResultBlob(parsed)) break;
            } catch { /* try next */ }
          }
        }

        const reportedSessionId = resolveSessionId(
          resumeSessionId ?? "",
          emittedSessionId,
          failed || (code ?? 1) !== 0,
        );

        const exitCode = failed && (code ?? 0) === 0 ? 1 : (code ?? 1);
        console.log(`[openclaw] Exited code=${code}, output=${fullOutput.length} chars, session=${reportedSessionId}`);
        resolve({
          exitCode,
          fullOutput,
          sessionId: reportedSessionId || undefined,
        });
      });

      proc.on("error", (err) => {
        console.error(`[openclaw] Spawn error: ${err.message}`);
        resolve({ exitCode: 1, fullOutput, sessionId: emittedSessionId || undefined });
      });
    });
  }

  /**
   * Read the tail of openclaw's session transcript. openclaw stores per-agent
   * transcripts at
   *   `~/.openclaw/agents/<agentName>/sessions/<sessionId>.jsonl`
   * (each file is NDJSON; first record is `{type:"session", id:<sessionId>, …}`).
   *
   * The executor is constructed without an agentName (rotom's a2a flow uses
   * the default agent), so we can't pin the path — we glob across every
   * agent's sessions directory for `<sessionId>.jsonl` and pick the first hit.
   *
   * Tolerant of missing files — returns empty content + an explanatory `error`
   * so the dashboard can distinguish "file gone" from "session started but
   * no output yet".
   */
  async readSessionContent(args: {
    sessionId: string;
    workingDir: string;
    tailLines?: number;
  }): Promise<{ format: "jsonl" | "text" | "raw"; content: string; error?: string }> {
    const file = findOpenclawSessionFile(args.sessionId, this.agentName);
    if (!file) {
      return {
        format: "jsonl",
        content: "",
        error: "openclaw session 文件不存在（可能已被 openclaw 清理，或 agent 名称不匹配）",
      };
    }
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n");
    const tail = args.tailLines ?? 200;
    const sliced = lines.length > tail ? lines.slice(-tail).join("\n") : text;
    return { format: "jsonl", content: sliced };
  }
}

// ── Openclaw session-file lookup ────────────────────────────────────────

/**
 * Resolve `~/.openclaw/agents/[<agentName>/]sessions/<sessionId>.jsonl`.
 *
 * When `agentName` is known we look in just that agent's directory; the
 * executor's instance field carries it when constructed with one. The
 * rotom-side a2a flow instantiates without a name (default agent), so we
 * fall back to scanning every agent's sessions directory for `<id>.jsonl`
 * and return the first match.
 */
function findOpenclawSessionFile(sessionId: string, agentName?: string): string | null {
  const target = `${sessionId}.jsonl`;
  if (agentName) {
    const pinned = path.join(os.homedir(), ".openclaw", "agents", agentName, "sessions", target);
    if (fs.existsSync(pinned)) return pinned;
  }
  const agentsRoot = path.join(os.homedir(), ".openclaw", "agents");
  if (!fs.existsSync(agentsRoot)) return null;
  let agents: string[];
  try {
    agents = fs.readdirSync(agentsRoot);
  } catch {
    return null;
  }
  for (const a of agents) {
    const candidate = path.join(agentsRoot, a, "sessions", target);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function extractErrorMessage(event: OpenclawEvent): string {
  if (event.error) {
    const e = event.error;
    if (e.data?.message) return e.data.message;
    if (e.message) return e.message;
    if (e.name) return e.name;
  }
  if (event.text) return event.text;
  if (event.message) return event.message;
  return "unknown openclaw error";
}

/**
 * Decide which session id to report. When resume was requested but openclaw
 * emitted a fresh, different session id AND the run failed, the resume did
 * not land — return "" so the caller can retry fresh.
 */
function resolveSessionId(
  requestedResume: string,
  emitted: string,
  failed: boolean,
): string {
  if (failed && requestedResume && emitted && emitted !== requestedResume) {
    return "";
  }
  return emitted;
}
