/**
 * Pi CLI Executor — port of multica/server/pkg/agent/pi.go.
 *
 * Spawns `pi -p --mode json --session <path> <prompt>` per turn
 * (spawn-and-exit executor).
 *
 *   - -p / --print        non-interactive mode; prompt is positional
 *   - --mode json         emit one JSON event per line on stdout, then exit
 *   - --session <path>    file path where Pi appends event JSONL; doubles as
 *                         our opaque session id (returned + reused on resume)
 *
 * Session as file path: we pre-create an empty file at the path before
 * spawning (Pi refuses to start when --session points at a missing file).
 * On resume we pass the same path back; Pi reads it to reconstruct history
 * and appends new events. readSessionContent reads the file directly — no
 * tree walk.
 *
 * stdin close (#2188): Pi's event loop polls stdin even in print mode. When
 * run under a daemon (no interactive TTY), Pi blocks awaiting stdin events
 * instead of progressing to "done". We close stdin immediately after spawn
 * to deliver an explicit EOF. Without this the process hangs for the full
 * wall-clock timeout.
 *
 * Tool-call markup sanitization: Pi's text_delta events can embed structured
 * tool-call markup (`<|call:bash{...}|>`, `<|response:{...}|>`) and control
 * tokens (`<|foo|>`) for providers that emit tool calls inline as text.
 * Providers using the anthropic-messages API emit tool calls as separate
 * toolcall_* events and text is clean, but we strip defensively so the user
 * never sees raw protocol markup. Ported from multica's
 * drainPiSanitizedText / stripPiToolCallMarkup.
 *
 * Usage: captured from turn_end.message.usage (accumulated across turns,
 * keyed by model). Pi may emit multiple turn_end events within one
 * execution; we sum them.
 */

import { runProcess } from "../process-runner.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliExecutor, ExecuteOptions, ExecuteResult, TokenUsage } from "../cli-executor.js";
import { buildPlanModeInstruction } from "../../shared/slash-commands.js";
import { emitStatus } from "../reasoning-status.js";
import { sliceTail } from "../adapter-helpers.js";

// ── Pi tool-call markup sanitization ───────────────────────────────────
// Ported from multica/server/pkg/agent/pi.go (stripPiToolCallMarkup et al.).

const PI_CONTROL_TOKEN_RE = /<\|[A-Za-z0-9_-]+>[A-Za-z0-9_-]*|<[A-Za-z0-9_-]+\|>/g;

export function stripPiControlTokens(s: string): string {
  return s.replace(PI_CONTROL_TOKEN_RE, "");
}

function isPiToolNameByte(b: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(b);
}

/** Find the next `call:` or `response:` prefix from index `from`. Returns
 *  `[index, prefixLen]`; index=-1 when none found. */
function nextPiToolMarkupPrefix(s: string, from: number): [number, number] {
  let best = -1;
  let bestLen = 0;
  for (const prefix of ["call:", "response:"]) {
    const i = s.indexOf(prefix, from);
    if (i >= 0 && (best === -1 || i < best)) {
      best = i;
      bestLen = prefix.length;
    }
  }
  return [best, bestLen];
}

/** Scan from the byte after a `call:`/`response:` prefix to the matching
 *  closing `}`. Handles `<|"|>` quote escaping and nested braces. Returns
 *  `[endIndex, ok]`; ok=false when the block is unterminated. */
function scanPiToolMarkupEnd(s: string, i: number): [number, boolean] {
  const nameStart = i;
  while (i < s.length && isPiToolNameByte(s[i])) i++;
  if (i === nameStart || i >= s.length || s[i] !== "{") return [0, false];

  const quoteMarker = '<|"|>';
  let depth = 0;
  let inQuote = false;
  while (i < s.length) {
    if (s.startsWith(quoteMarker, i)) {
      inQuote = !inQuote;
      i += quoteMarker.length;
      continue;
    }
    if (!inQuote) {
      if (s[i] === "{") {
        depth++;
      } else if (s[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          if (s.startsWith("<tool_call|>", i)) i += "<tool_call|>".length;
          return [i, true];
        }
      }
    }
    i++;
  }
  return [0, false];
}

export function stripPiStructuredToolMarkup(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const [start, prefixLen] = nextPiToolMarkupPrefix(s, i);
    if (start === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    const [end, ok] = scanPiToolMarkupEnd(s, start + prefixLen);
    if (!ok) {
      out += s.slice(start);
      break;
    }
    i = end;
  }
  return out;
}

export function stripPiToolCallMarkup(s: string): string {
  return stripPiControlTokens(stripPiStructuredToolMarkup(s));
}

/** Detect a partial control-token prefix at end of buffer (`<|foo` without
 *  closing `|>`), so we can hold it back until we see more deltas. */
export function looksLikePiControlTokenPrefix(s: string): boolean {
  if (s.length === 0 || s[0] !== "<" || s.length > 64) return false;
  for (let i = 1; i < s.length; i++) {
    if (!/[A-Za-z0-9_|>-]/.test(s[i])) return false;
  }
  return true;
}

/** How much of the tail we can safely emit now without cutting a markup
 *  prefix in half. Holds back any suffix that looks like the start of
 *  `call:` / `response:` or a partial control token. */
export function safePiTextEmitLen(s: string): number {
  let hold = 0;
  for (const prefix of ["call:", "response:"]) {
    for (let n = 1; n < prefix.length && n <= s.length; n++) {
      if (s.endsWith(prefix.slice(0, n)) && n > hold) hold = n;
    }
  }
  const lt = s.lastIndexOf("<");
  if (lt >= 0 && looksLikePiControlTokenPrefix(s.slice(lt))) {
    if (s.length - lt > hold) hold = s.length - lt;
  }
  return s.length - hold;
}

/** Core drain: emit sanitized text, return `[emit, pending]`. `pending` is
 *  the un-emittable tail (partial markup prefix or unterminated block). */
export function drainPiSanitizedText(s: string): [string, string] {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const [start, prefixLen] = nextPiToolMarkupPrefix(s, i);
    if (start === -1) {
      const safeLen = safePiTextEmitLen(s.slice(i));
      out += s.slice(i, i + safeLen);
      return [stripPiControlTokens(out), s.slice(i + safeLen)];
    }
    out += s.slice(i, start);
    const [end, ok] = scanPiToolMarkupEnd(s, start + prefixLen);
    if (!ok) {
      return [stripPiControlTokens(out), s.slice(start)];
    }
    i = end;
  }
  return [stripPiControlTokens(out), ""];
}

/**
 * Running text buffer that accumulates text_delta chunks and emits sanitized
 * prose, holding back partial markup prefixes so we don't emit `<|call:bash`
 * then realize on the next delta it was the start of a tool-call block.
 */
export class PiTextBuffer {
  private buf = "";
  append(delta: string): string {
    this.buf += delta;
    const [emit, pending] = drainPiSanitizedText(this.buf);
    this.buf = pending;
    return emit;
  }
  flush(): string {
    const s = this.buf;
    this.buf = "";
    const [emit, pending] = drainPiSanitizedText(s);
    return emit + stripPiControlTokens(pending);
  }
}

// ── Pi event shapes (loose — tolerate future minor-version field additions) ──

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface PiMessage {
  role?: string;
  model?: string;
  usage?: PiUsage;
}

interface PiAssistantMessageEvent {
  type?: string;
  delta?: string;
}

interface PiEvent {
  type?: string;
  // message_update
  assistantMessageEvent?: PiAssistantMessageEvent;
  // tool_execution_start / tool_execution_end
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // turn_end / error — `message` is an object on turn_end, a string on error
  message?: PiMessage | string;
  // auto_retry_end
  success?: boolean;
  finalError?: string;
}

// ── Executor ────────────────────────────────────────────────────────────

const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const PI_SESSIONS_DIR = path.join(ROTOM_HOME, "pi-sessions");

function newPiSessionPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "T");
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(PI_SESSIONS_DIR, `${stamp}-${rand}.jsonl`);
}

function ensurePiSessionFile(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Pi refuses to start when --session points at a missing file. Create an
  // empty file if none exists; leave existing files (resumed sessions)
  // untouched so Pi can append.
  if (!fs.existsSync(p)) {
    const f = fs.openSync(p, "w");
    fs.closeSync(f);
  }
}

export class PiExecutor implements CliExecutor {
  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      // Session path: reuse the cached one if its file still exists;
      // otherwise mint a new one (the old session was pruned by pi or
      // invalidated, so we start fresh).
      let sessionPath = options?.sessionId ?? "";
      if (sessionPath && !fs.existsSync(sessionPath)) {
        console.log(`[pi] cached session file missing, starting fresh: ${sessionPath}`);
        sessionPath = "";
      }
      if (!sessionPath) {
        sessionPath = newPiSessionPath();
      }
      ensurePiSessionFile(sessionPath);

      // prompt 已由 worker 用 composePrompt() 拼好,executor 不再二次包装。

      const args = ["-p", "--mode", "json", "--session", sessionPath];
      // --append-system-prompt 同时承载静态系统层(rotom-cli/角色/群身份/cwd,
      // 来自 worker 的 systemPrompt)和 /plan 指令(pi 无原生 plan 模式)。
      // 会话内静态层不变,每轮幂等重传同一段。注册表见 src/shared/slash-commands.ts。
      const planInstr = options?.slashCommand === "/plan" ? buildPlanModeInstruction() : null;
      const appendSystem = [options?.systemPrompt, planInstr].filter(Boolean).join("\n");
      if (appendSystem) {
        args.push("--append-system-prompt", appendSystem);
      }
      args.push(prompt);

      const spawnEnv = { ...process.env, ...options?.env };
      const timeoutMs = options?.timeoutMs;
      console.log(
        `[pi] Spawning pi -p --mode json (cwd: ${workingDir}, session: ${sessionPath}, slash: ${options?.slashCommand ?? "(none)"}, timeoutMs=${timeoutMs ?? "none"})`,
      );

      const { proc, done: procDone } = runProcess({
        bin: "pi",
        args,
        cwd: workingDir,
        env: spawnEnv as Record<string, string>,
        label: "pi",
        signal: options?.signal,
        timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs + 5_000 : undefined,
      });

      // #2188 fix: close stdin immediately. Pi's event loop polls stdin even
      // in print mode; under a daemon (no TTY) it blocks awaiting stdin
      // events instead of finishing. EOF unblocks the readable side.
      try { proc.stdin?.end(); } catch { /* already closed */ }

      // ── Per-run state ──
      let timedOut = false;
      let killedByUser = false;
      let done = false;
      let fullOutput = "";
      let capturedModel: string | undefined;
      let capturedUsage: TokenUsage | undefined;
      let failed = false;
      let errorMessage: string | undefined;
      let sawTurnEnd = false;
      const textBuffer = new PiTextBuffer();

      if (options?.signal) {
        if (options.signal.aborted) killedByUser = true;
        else options.signal.addEventListener("abort", () => { killedByUser = true; }, { once: true });
      }

      function handleEvent(event: PiEvent): void {
        switch (event.type) {
          case "session":
            // Header line (emitted in json mode). We already know our
            // session path — nothing to capture.
            return;
          case "agent_start":
            emitStatus(onOutput, "Working");
            return;
          case "message_update": {
            const sub = event.assistantMessageEvent;
            if (!sub) return;
            switch (sub.type) {
              case "text_delta": {
                if (sub.delta) {
                  const emit = textBuffer.append(sub.delta);
                  if (emit) {
                    fullOutput += emit;
                    onOutput(emit);
                  }
                }
                return;
              }
              case "thinking_delta": {
                // v1: 不把 thinking 流推给 dashboard(只在 stderr 记日志),
                // 避免和正文混杂。后续可考虑用 [thinking]…[/thinking] 块。
                if (sub.delta && (process.env.PI_VERBOSE || options?.env?.PI_VERBOSE)) {
                  console.error(`[pi:thinking] ${sub.delta}`);
                }
                return;
              }
              default:
                // text_start / text_end / thinking_start / thinking_end /
                // toolcall_* — 不需要,v1 只消费 text_delta 和独立的
                // tool_execution_* 事件。
                return;
            }
          }
          case "tool_execution_start":
            onOutput(`[tool:exec]${JSON.stringify(event.args ?? {})}[/tool:exec]\n`);
            emitStatus(onOutput, toolStatusFor(event.toolName));
            return;
          case "tool_execution_end": {
            const text = extractToolResultText(event.result);
            if (text) {
              const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
              onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
            }
            if (event.isError) {
              console.warn(`[pi] tool ${event.toolName} (${event.toolCallId}) returned isError=true`);
            }
            emitStatus(onOutput, "Working");
            return;
          }
          case "turn_end": {
            sawTurnEnd = true;
            const msg = event.message as PiMessage | undefined;
            capturedUsage = accumulatePiUsage(capturedUsage, msg);
            if (msg && typeof msg === "object" && msg.model && !capturedModel) capturedModel = msg.model;
            // Flush any buffered text in case the turn ended without a final
            // text_delta closing the buffer.
            const flushed = textBuffer.flush();
            if (flushed) {
              fullOutput += flushed;
              onOutput(flushed);
            }
            emitStatus(onOutput, failed ? "Failed" : "Answered");
            return;
          }
          case "error": {
            const msg = typeof event.message === "string" ? event.message : "pi error";
            console.error(`[pi] error event: ${msg}`);
            onOutput(`[error] ${msg}\n`);
            if (!failed) {
              failed = true;
              errorMessage = msg;
            }
            emitStatus(onOutput, "Failed");
            return;
          }
          case "auto_retry_end": {
            if (event.success === false && !failed) {
              failed = true;
              errorMessage = event.finalError || "pi exhausted automatic retries";
              console.error(`[pi] auto_retry_end failed: ${errorMessage}`);
              emitStatus(onOutput, "Failed");
            }
            return;
          }
          // agent_end / turn_start / message_start / message_end /
          // tool_execution_update / compaction_* / queue_update /
          // extension_ui_request — v1 不消费。usage 从 turn_end 拿(更可靠);
          // 工具执行从 tool_execution_* 拿(不靠 message_end)。
          default:
            return;
        }
      }

      function handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed[0] !== "{") return; // non-JSON log noise on stdout (rare)
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        handleEvent(parsed as PiEvent);
      }

      function finalize(code: number | null, reason: "close" | "error"): void {
        if (done) return;
        done = true;

        const flushed = textBuffer.flush();
        if (flushed) {
          fullOutput += flushed;
          onOutput(flushed);
        }

        const finalCode = code ?? 0;
        // 进程退出但没发 turn_end(被 SIGKILL / 崩溃) → 视为失败,让 worker
        // 丢缓存 sessionId 下次重开。
        if (!sawTurnEnd && !killedByUser && finalCode !== 0 && !failed) {
          failed = true;
          errorMessage = `pi exited with code ${finalCode} without producing turn_end`;
        }

        if (!fullOutput && failed) {
          if (timedOut) {
            fullOutput = `[错误] pi 执行超时 (>${timeoutMs}ms)，已强制结束`;
          } else if (reason === "error") {
            fullOutput = `[错误] pi 启动失败`;
          } else {
            fullOutput = `[错误] pi 返回内容为空 (exit=${finalCode})`;
          }
        }

        console.log(
          `[pi] Exited code=${finalCode} reason=${reason}, output=${fullOutput.length} chars, session=${sessionPath}, turn_end=${sawTurnEnd}`,
        );
        resolve({
          exitCode: failed && finalCode === 0 ? 1 : finalCode,
          fullOutput,
          sessionId: sessionPath,
          usage: capturedUsage,
          model: capturedModel,
          failed: failed || undefined,
          errorMessage,
        });
      }

      let stdoutBuffer = "";
      proc.stdout!.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        let idx: number;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          handleLine(line);
        }
      });

      // stderr: log-only. Pi 在 verbose 模式下会把诊断/堆栈打到 stderr,不含 JSON。
      proc.stderr!.on("data", (data: Buffer) => {
        if (process.env.PI_VERBOSE || options?.env?.PI_VERBOSE) {
          console.error(`[pi:stderr] ${data.toString().trimEnd()}`);
        }
      });

      procDone.then(({ exitCode, signal }) => {
        if (signal === "SIGKILL" && !killedByUser && timeoutMs && timeoutMs > 0) {
          timedOut = true;
          console.warn(`[pi] Wall-clock timeout (${timeoutMs}ms + 5_000ms grace) reached, SIGKILL pid=${proc.pid}`);
        }
        finalize(exitCode, "close");
      });
    });
  }

  /**
   * Read the tail of pi's session transcript. Since we own the session file
   * path (passed to `pi --session <path>`), we read it directly — no tree
   * walk. Tolerant of missing files (pi may prune, or the session was
   * invalidated) — returns empty content + an explanatory `error`.
   */
  async readSessionContent(args: {
    sessionId: string;
    workingDir: string;
    tailLines?: number;
  }): Promise<{ format: "jsonl" | "text" | "raw"; content: string; error?: string }> {
    const file = args.sessionId;
    if (!file || !fs.existsSync(file)) {
      return {
        format: "jsonl",
        content: "",
        error: "pi session 文件不存在（可能已被清理或会话失效）",
      };
    }
    const text = fs.readFileSync(file, "utf-8");
    return { format: "jsonl", content: sliceTail(text, args.tailLines ?? 200) };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function toolStatusFor(name?: string): string {
  switch (name) {
    case "edit":
    case "write":
      return "Patching";
    case "bash":
      return "Running";
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "Reading";
    default:
      return "Running";
  }
}

/**
 * 把 pi turn_end 的 message.usage 累加进已累积的 TokenUsage。pi 一次执行可能
 * 发多次 turn_end,各次 usage 相加 = 整个 issue 的总量。msg 无 usage 时原样
 * 返回 prev(不变)。抽成纯函数便于离线测试。
 */
export function accumulatePiUsage(prev: TokenUsage | undefined, msg: PiMessage | undefined): TokenUsage | undefined {
  if (!msg || typeof msg !== "object" || !msg.usage) return prev;
  const u = msg.usage;
  return {
    inputTokens: (prev?.inputTokens ?? 0) + u.input,
    outputTokens: (prev?.outputTokens ?? 0) + u.output,
    cacheReadTokens: (prev?.cacheReadTokens ?? 0) + u.cacheRead,
    cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + u.cacheWrite,
    totalCostUsd: prev?.totalCostUsd,
  };
}

export function extractToolResultText(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const r = result as { text?: unknown; output?: unknown };
    if (typeof r.text === "string") return r.text;
    if (typeof r.output === "string") return r.output;
  }
  try {
    const s = JSON.stringify(result);
    return s && s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}
