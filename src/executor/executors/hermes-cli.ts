/**
 * Hermes CLI Executor
 *
 * Spawns `hermes acp` and communicates via ACP (Agent Communication Protocol)
 * JSON-RPC 2.0 over stdin/stdout. Follows the same lifecycle as the Go
 * reference implementation in Multica:
 *
 *   1. initialize handshake
 *   2. session/new
 *   3. session/prompt (streams updates via session/update notifications)
 *   4. auto-approve permission requests
 */

import { runProcess } from "../process-runner.js";
import { createJsonRpcTransport, type JsonRpcTransport } from "../jsonrpc-transport.js";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { CliExecutor, ExecuteOptions, ExecuteResult, TokenUsage } from "../cli-executor.js";
import {
  createReasoningStatusBuffer,
  emitStatus,
} from "../reasoning-status.js";

// ── Tool call buffer ────────────────────────────────────────────────────

interface PendingToolCall {
  toolName: string;
  input?: Record<string, unknown>;
  argsText: string;
  emitted: boolean;
}

// ── Provider error detection ────────────────────────────────────────────
// Mirrors multica's acpProviderErrorSniffer / acpAgentOutputTerminalRe
// (server/pkg/agent/hermes.go). Hermes emits its final response
// (`"API call failed after N retries: ..."`) via
// acp_adapter/server.py:1634 as a regular `agent_message_chunk`, so without
// sniffing we'd happily stream "API call failed after 3 retries: Connection
// error." to the dashboard as if the agent had actually said that.
//
// We match in TWO places:
//   1. stderr lines (hermes logs the same failure there at WARNING level).
//   2. `agent_message_chunk.text` (the user-visible "reply").
// First hit flips `providerError.matched`; once set we stop accumulating
// `fullOutput` for matching chunks and surface a clean error instead.

const PROVIDER_ERROR_PATTERNS: RegExp[] = [
  // "API call failed after 3 retries: Connection error." (hermes primary)
  /API call failed after \d+ retr(?:y|ies)/i,
  // SDK-level error names — backup signal in case the summary line is
  // truncated or absent.
  /\bAPIConnectionError\b/,
  /\bBadRequestError\b/,
  /\bAuthenticationError\b/,
  /\bRateLimitError\b/,
  // "Non-retryable …" prefix hermes logs on unrecoverable failures.
  /Non-retryable/i,
  // hermes also prints bracketed ERROR markers via conversation_loop.
  /\[ERROR\]/,
  // 4xx/5xx in the same line as an error keyword (covers HTTP 401/429/500/…).
  /\bHTTP\s+[45]\d{2}\b.*(?:error|fail|denied|forbidden|unauthor)/i,
];

function matchProviderError(text: string): RegExpMatchArray | null {
  for (const re of PROVIDER_ERROR_PATTERNS) {
    const m = text.match(re);
    if (m) return m;
  }
  return null;
}

// Pull a *clean* error reason out of a hermes stderr line, in priority order:
//
//   1. `summary=Connection error.`  →  "Connection error"
//   2. `❌ API failed after N retries — Connection error.`  →
//        "API failed after N retries — Connection error"
//   3. `💀 Final error: Connection error.`  →  "Final error: Connection error"
//   4. `API call failed after N retries. <Reason>.`  →
//        "API call failed after N retries: <Reason>"
//   5. fallback  →  "provider error"
//
// The matched line itself is almost always a structured log record (timestamp
// + level + thread + provider metadata); we don't want to surface that
// verbatim — see the worker.ts "[错误] 模型调用失败: …" branch.
const CLEAN_ERROR_PATTERNS: RegExp[] = [
  // `summary=...` 字段是 hermes 的归一化错误信息,几乎所有 WARNING/ERROR 行都有
  /\bsummary=([^\s|]+(?:[ ][^\s|]+)*?)(?:\s*\||\s*$)/,
  // prettier 错误横幅
  /❌\s*API\s+failed\s+after\s+\d+\s+retries?\s*[—–-]\s*([^\n]+?)\.?\s*$/,
  /💀\s*Final\s+error:\s*([^\n]+?)\.?\s*$/,
  // ERROR 行的 "API call failed after N retries. <Reason>."
  /API\s+call\s+failed\s+after\s+\d+\s+retries?\.?\s*([^|.]*?)\s*\.?\s*$/,
];

function extractCleanErrorReason(text: string): string {
  for (const re of CLEAN_ERROR_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const reason = m[1].trim().replace(/\s+/g, " ");
      if (reason && reason.length < 200) return reason;
    }
  }
  return "provider error";
}

// ── Executor ────────────────────────────────────────────────────────────

/**
 * Build the env passed to the hermes subprocess.
 *
 * Why not just spread `process.env`? The rotom executor daemon is launched
 * from a shell that may have local-proxy / IDE-vars polluting env
 * (ANTHROPIC_BASE_URL=http://127.0.0.1:58082, ANTHROPIC_AUTH_TOKEN=sk-cp-...,
 * CCV_PROXY_MODE=1, plus ANTHROPIC_DEFAULT_*_MODEL overrides). When those
 * leak into the hermes subprocess they cause ACP `session/resume`'s 2nd
 * turn to fail with `APIConnectionError` to whatever URL those vars
 * point at (the connection is alive enough to consume the request but
 * not enough to deliver a response). Verified 2026-06-14:
 *
 *   env with CCV leak + ACP session/new + 2nd session/prompt
 *     → 2nd turn: "API call failed after 3 retries: Connection error."
 *   same scenario with CCV vars stripped
 *     → 2nd turn: normal reply, history replayed correctly
 *
 * `hermes-agent` is configured via `~/.hermes/config.yaml` (model +
 * base_url) and `~/.hermes/.env` (ANTGROUP_API_KEY); it does not read
 * ANTHROPIC_* from env. The Anthropic SDK inside hermes, however, does
 * pick up ANTHROPIC_BASE_URL as a transport-level fallback for some
 * paths, which is enough to misroute the 2nd connection.
 *
 * We strip the leaky vars here and let hermes read its own config.
 */
function buildHermesEnv(
  parentEnv: NodeJS.ProcessEnv,
  optionsEnv: Record<string, string> | undefined,
  mergedPath: string | undefined,
): NodeJS.ProcessEnv {
  // We strip by *prefix* for the Claude Code / Anthropic env family because
  // the SDK picks up any of `ANTHROPIC_*`, `CLAUDE*`, `CLAUDECODE` and the
  // exact list grows over time. Anything that smells like Claude Code
  // session bookkeeping (CLAUDE_CODE_EXECUTABLE, _SSE_PORT, _SUBAGENT_MODEL,
  // CLAUDECODE, ...) should NOT leak into a hermes subprocess — those are
  // signals about the rotom daemon's own claude-code execution, not hermes.
  const STRIPPED_PREFIXES = [
    "ANTHROPIC_",
    "CLAUDE_CODE_",
    "CLAUDECODE",
  ];
  const STRIPPED_EXACT = new Set([
    "CCV_PROXY_MODE",
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (STRIPPED_EXACT.has(k)) continue;
    if (STRIPPED_PREFIXES.some((p) => k === p || k.startsWith(p))) continue;
    out[k] = v;
  }
  if (optionsEnv) Object.assign(out, optionsEnv);
  out.PATH = mergedPath ?? parentEnv.PATH ?? "";
  out.HERMES_YOLO_MODE = "1";
  console.log(`[hermes-cli] buildHermesEnv: stripping results in ${Object.keys(out).length} keys:`);
  for (const k of Object.keys(out).sort()) {
    console.log(`[hermes-cli]   env.${k} = ${(out[k] ?? "").toString().slice(0, 100)}`);
  }
  return out;
}

export class HermesCliExecutor implements CliExecutor {
  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const args = [ "acp"];
      const resumeSessionId = options?.sessionId || "";

      console.log(`[hermes-cli] Spawning hermes acp (cwd: ${workingDir})`);

      // hermes lives in a venv (`~/hermes-agent/venv/bin`) and is not on the
      // default PATH of a daemonised master. Prepend the candidate locations
      // so `spawn("hermes")` finds it.
      const extraPath = [
        path.join(os.homedir(), "hermes-agent", "venv", "bin"),
      ].filter((p) => fs.existsSync(p)).join(":");
      const mergedPath = extraPath
        ? `${extraPath}:${process.env.PATH ?? ""}`
        : process.env.PATH;

      const { proc } = runProcess({
        bin: "hermes",
        args,
        cwd: workingDir,
        env: buildHermesEnv(process.env, options?.env, mergedPath) as Record<string, string>,
        label: "hermes-cli",
        signal: options?.signal,
      });

      let fullOutput = "";
      const pendingTools = new Map<string, PendingToolCall>();
      let sessionId = "";
      let settled = false;
      let inThinking = false;
      // Set when we receive the ACP turn_end notification, so finish() can
      // distinguish "model finished cleanly" (already emitted "Answered")
      // from "process died before turn_end ever arrived" (needs a terminal
      // emit to keep the dashboard status pill from sticking on "Working").
      let turnEndSeen = false;
      // Set when a terminal provider/model error is detected in stderr or
      // in an agent_message_chunk — see matchProviderError() above. When
      // set, finish() returns `failed: true` so the worker surfaces a
      // clean error and drops the cached sessionId (next turn starts
      // fresh with session/new, which is the only path that currently
      // works for the session/resume + second-prompt bug).
      // `message` is the user-facing reason (extracted via
      // extractCleanErrorReason so we never surface raw log records).
      let providerError: { matched: boolean; message: string } = {
        matched: false,
        message: "",
      };
      // Buffer agent_message_chunk text so a split error string
      // ("API call failed " + "after 3 retries: …") still matches. We
      // only ever inspect this buffer for the regex; the chunks
      // themselves still stream to onOutput.
      let agentTextBuffer = "";
      // Hermes 的 agent_message_chunk 切得很细(中文甚至逐字),每次 chunk
      // 后都 emitStatus("Working") 会把正文切成一堆被 [status:thinking] 包围的
      // 短段,即使前端能合并渲染,持久化进 DB 的 content 仍然会污染。
      // 用一个本地 lastEmitted 跟踪上一次 emit 的 status,值不变就不再 emit。
      let lastStatusEmitted = "";
      function emitStatusDedup(text: string): void {
        if (text === lastStatusEmitted) return;
        lastStatusEmitted = text;
        emitStatus(onOutput, text);
      }
      // 从 reasoning 流里抽第一个 **Header**,emit 为 [status:thinking] 标签,
      // 在 dashboard 顶部以 shimmer pill 形式展示。完全对齐 codex-rs/tui 的
      // extract_first_bold + set_status_header 模式。
      const reasoningStatus = createReasoningStatusBuffer((tag) => onOutput(tag));
      // 新版 hermes ACP 在 session/resume 里会同步 replay 整段对话历史
      // （user/assistant/thought chunks，跟 live chunk 类型完全相同）。
      // hermes 是 await 完 replay 才返回 session/resume 的 RPC 响应，所以
      // 我们用这一段时间窗口作为屏蔽：replayActive=true 时所有 session_update
      // 全部静默吞掉，避免把历史重复推给前端。
      let replayActive = false;
      let capturedUsage: TokenUsage | undefined;
      let capturedModel: string | undefined;

      // 新版 hermes 把思考内容拆成很多小 chunk 流式下发，必须把连续的
      // thought chunk 合并到同一个 [thinking]...[/thinking] 块里，否则
      // 前端解析器会把每个 chunk 渲染成独立的 "💭 思考" 折叠块。
      function closeThinkingIfOpen(): void {
        if (inThinking) {
          onOutput(`[/thinking]`);
          inThinking = false;
        }
        // reasoning section 结束，清掉 reasoningStatus 的 lastEmitted
        // 记忆。下次再有 thought chunk 且抽出同一个 **Header**，也会
        // 重新 emit 一次（pill 视觉上保持，因为 dashboard 端只保留最新
        // 的 [status:thinking] tag）。
        reasoningStatus.reset();
      }

      // ── JSON-RPC transport ──
      // The transport owns the readline loop, the pending-request map, and
      // the JSON frame formatting. We plug our domain handlers into the
      // onRequest / onNotification callbacks below.
      const transport: JsonRpcTransport = createJsonRpcTransport({
        stdin: proc.stdin,
        stdout: proc.stdout,
        label: "hermes-cli",
        onRequest: (method, params, id) => handleAgentRequest(method, params, id),
        onNotification: (method, params) => handleNotification(method, params),
      });

      // ── Helpers ──

      function send(msg: Record<string, unknown>): void {
        transport.send(msg);
      }

      function request(method: string, params?: unknown): Promise<unknown> {
        return transport.request(method, params);
      }

      function finish(exitCode: number): void {
        if (settled) return;
        settled = true;
        closeThinkingIfOpen();
        // Fallback terminal status: if the process died without us ever
        // seeing a turn_end (e.g. spawn error, model 400, broken pipe),
        // emit something so the dashboard's status pill doesn't stay on
        // "Working" forever. Successful turns already emitted "Answered"
        // in the turn_end case, so this is a no-op for the happy path.
        if (!turnEndSeen && !providerError.matched) {
          emitStatus(onOutput, exitCode === 0 ? "Done" : "Failed");
        }
        // Provider error path — return failed/invalidateSession so the
        // worker surfaces a clean error and drops the cached sessionId
        // (next turn starts fresh with session/new, which is the only
        // path that currently works for the session/resume bug).
        if (providerError.matched) {
          console.warn(
            `[hermes-cli] Provider error → returning failed. exitCode=${exitCode} message="${providerError.message}"`,
          );
        }
        console.log(`[hermes-cli] Exited code=${exitCode}, output=${fullOutput.length} chars, session=${sessionId}, model=${capturedModel ?? "(none)"}, usage=${capturedUsage ? JSON.stringify(capturedUsage) : "(none)"}`);
        resolve({
          exitCode,
          fullOutput,
          sessionId: providerError.matched ? undefined : (sessionId || undefined),
          invalidateSession: providerError.matched || undefined,
          failed: providerError.matched || undefined,
          errorMessage: providerError.matched ? providerError.message : undefined,
          usage: capturedUsage,
          model: capturedModel,
        });
      }

      // ── Handle agent → client requests (auto-approve permissions) ──

      // ACP 各版本对 permission 选项的命名不一样（approve_for_session /
      // allow_always / allow_once / approve_once …）。直接读 params.options，
      // 按优先级匹配一个"允许"类的 option；找不到就退回到 options[0]，最坏
      // 也比硬编码一个不存在的 ID 让 agent 卡住等审批要好。
      function pickApproveOption(params: unknown): string {
        const options = (params as Record<string, unknown> | undefined)?.options;
        if (!Array.isArray(options) || options.length === 0) {
          return "approve_for_session";
        }
        const ids = options
          .map((o) => (o as Record<string, unknown>)?.optionId as string | undefined)
          .filter((id): id is string => typeof id === "string");
        const priority = [
          /^approve_for_session$/i,
          /^allow_always$/i,
          /^always_allow$/i,
          /^allow_for_session$/i,
          /^approve$/i,
          /^allow_once$/i,
          /^approve_once$/i,
          /allow/i,
          /approve/i,
        ];
        for (const re of priority) {
          const hit = ids.find((id) => re.test(id));
          if (hit) return hit;
        }
        return ids[0] ?? "approve_for_session";
      }

      function handleAgentRequest(method: string, rawParams: unknown, id: number | string): void {
        let resp: Record<string, unknown>;
        if (method === "session/request_permission") {
          const optionId = pickApproveOption(rawParams);
          console.log(`[hermes-cli] auto-approve permission → ${optionId}`);
          resp = {
            jsonrpc: "2.0",
            id,
            result: {
              outcome: {
                outcome: "selected",
                optionId,
              },
            },
          };
        } else {
          console.warn(`[hermes-cli] unhandled agent→client method: ${method} (params=${JSON.stringify(rawParams).slice(0, 200)})`);
          resp = {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          };
        }
        send(resp);
      }

      // ── Handle JSON-RPC responses ──
      // (The transport's pending map owns this — responses matching a
      //  transport.request() id resolve the corresponding promise.)

      // ── ACP notification handling ──

      function normalizeUpdateType(raw: unknown): string {
        if (typeof raw === "object" && raw !== null) {
          const obj = raw as Record<string, unknown>;
          const key =
            (obj.sessionUpdate as string) ??
            (obj.type as string);
          if (key) return normalizeTypeKey(key);

          // Externally tagged: { agentMessageChunk: { ... } }
          const keys = Object.keys(obj);
          if (keys.length === 1) return normalizeTypeKey(keys[0]);
        }
        return "";
      }

      function normalizeTypeKey(t: string): string {
        const k = t.replace(/[-_]/g, "").toLowerCase().trim();
        switch (k) {
          case "agentmessagechunk": return "agent_message_chunk";
          case "agentthoughtchunk": return "agent_thought_chunk";
          case "toolcall": return "tool_call";
          case "toolcallupdate": return "tool_call_update";
          case "usageupdate": return "usage_update";
          case "turnend":
          case "endturn": return "turn_end";
          default: return "";
        }
      }

      // hermes 给的 `title` 通常是 `terminal: $ rotom ...`,直接塞进
      // [tool:exec] 会被前端 ToolCallBlock 渲染成 `$ $ rotom ...`(block
      // 本身就前置一个 `$` 提示符)。这里把开头的 `$` 去掉,让渲染干净。
      function stripLeadingDollarPrompt(s: string): string {
        return s.replace(/^\$\s*/, "");
      }

      function toolNameFromTitle(title: string, kind: string): string {
        if (title === "execute code") return "execute_code";
        const idx = title.indexOf(":");
        if (idx > 0) {
          const name = title.slice(0, idx).trim();
          const map: Record<string, string> = {
            terminal: "terminal",
            read: "read_file",
            write: "write_file",
            search: "search_files",
            "web search": "web_search",
            extract: "web_extract",
            delegate: "delegate_task",
            "analyze image": "vision_analyze",
          };
          if (map[name]) return map[name];
          if (name.startsWith("patch")) return "patch";
          return name;
        }
        const kindMap: Record<string, string> = {
          read: "read_file",
          edit: "write_file",
          execute: "terminal",
          search: "search_files",
          fetch: "web_search",
          think: "thinking",
        };
        return kindMap[kind] ?? title ?? kind;
      }

      // 新版 hermes 把"polished"工具（read_file/terminal/skill_view/...）
      // 的参数写在 content[].content.text 里而不是 rawInput（见
      // acp_adapter/tools.py:_POLISHED_TOOLS）。我们之前只读 rawInput
      // 所以这些工具全显示成 `[tool] read_file: undefined`。
      // 这里把 content 里第一段非空文本块当成参数展示来源。
      function extractArgsFromContent(update: Record<string, unknown>): string | undefined {
        const content = update.content as unknown;
        if (!Array.isArray(content)) return undefined;
        for (const block of content) {
          const b = block as Record<string, unknown> | undefined;
          const inner = b?.content as Record<string, unknown> | undefined;
          const text = inner?.text as string | undefined;
          if (typeof text === "string" && text.trim()) return text;
        }
        return undefined;
      }

      function handleNotification(method: string, rawParams: unknown): void {
        if (method !== "session/update" && method !== "session/notification") return;

        const params = rawParams as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (!update) return;

        // session/resume 期间到达的全是历史 replay（user/assistant/thought
        // chunks 形态与 live 完全相同），直接吞掉。等 resume RPC 返回，
        // replayActive 会被置 false，后续 session/prompt 的 update 才会进 switch。
        if (replayActive) return;

        const updateType = normalizeUpdateType(update);

        if (process.env.ROTOM_HERMES_DEBUG) {
          const obj = update as Record<string, unknown>;
          const rawKey = (obj.sessionUpdate as string) ?? (obj.type as string) ?? Object.keys(obj)[0] ?? "(none)";
          console.log(`[hermes DEBUG] session/update updateType=${updateType || "(unhandled)"} rawKey=${rawKey} keys=${Object.keys(obj).slice(0, 8).join(",")}`);
        }

        switch (updateType) {
          case "agent_message_chunk": {
            const content = (update as Record<string, unknown>).content as Record<string, unknown> | undefined;
            const text = content?.text as string | undefined;
            if (text) {
              // Buffer-then-check so split chunks ("API call failed " +
              // "after 3 retries: …") still trigger the sniffer. Cap the
              // buffer at 1 KiB — anything bigger is clearly not just
              // an error string and we don't want to grow it forever.
              agentTextBuffer = (agentTextBuffer + text).slice(-1024);
              if (!providerError.matched) {
                const m = matchProviderError(agentTextBuffer);
                if (m) {
                  providerError = { matched: true, message: extractCleanErrorReason(agentTextBuffer) };
                  emitStatus(onOutput, "Failed");
                  console.error(`[hermes-cli] provider error detected in agent_message_chunk: ${m[0]}`);
                }
              }
              closeThinkingIfOpen();
              // If this chunk is part of a provider-error reply, do NOT
              // accumulate it into fullOutput — the worker uses fullOutput
              // as the assistant's "answer" and we don't want
              // "API call failed after 3 retries: …" rendered as such.
              // We still stream it to onOutput so the dashboard sees the
              // raw event for debugging, and the live status pill flips
              // to "Failed" via emitStatus above.
              if (!providerError.matched) {
                fullOutput += text;
              }
              onOutput(text);
              // 模型已经从「思考」切到「回答」,状态 pill 切回 "Working"。
              // 当 sniffer 已经标记失败时,跳过这条 emit,保留上面 "Failed"
              // 作为最后一个状态,避免 dashboard pill 被覆盖回 "Working"。
              if (!providerError.matched) {
                emitStatusDedup("Working");
              }
            }
            break;
          }
          case "agent_thought_chunk": {
            const content = (update as Record<string, unknown>).content as Record<string, unknown> | undefined;
            const text = content?.text as string | undefined;
            if (text) {
              if (!inThinking) {
                onOutput(`[thinking]`);
                inThinking = true;
              }
              onOutput(text);
              // 把 chunk 累加到 reasoningStatus,首次抽出 **Header** 时自动
              // emit 一个 [status:thinking] 标签。
              reasoningStatus.append(text);
            }
            break;
          }
          case "tool_call": {
            closeThinkingIfOpen();
            const u = update as Record<string, unknown>;
            const toolCallId = u.toolCallId as string;
            const title = u.title as string;
            const kind = u.kind as string;
            const rawInput = (u.rawInput ?? u.input ?? u.parameters) as Record<string, unknown> | undefined;
            // polished 工具的参数走 content text block，rawInput 会是 null
            const contentArgs = extractArgsFromContent(u);

            const toolName = toolNameFromTitle(title ?? "", kind ?? "");
            if (rawInput && Object.keys(rawInput).length > 0) {
              pendingTools.set(toolCallId, { toolName, input: rawInput, argsText: "", emitted: true });
              onOutput(`[tool:exec]${stripLeadingDollarPrompt(JSON.stringify(rawInput))}[/tool:exec]\n`);
            } else if (contentArgs) {
              pendingTools.set(toolCallId, { toolName, argsText: contentArgs, emitted: true });
              onOutput(`[tool:exec]${stripLeadingDollarPrompt(contentArgs)}[/tool:exec]\n`);
            } else {
              pendingTools.set(toolCallId, { toolName, argsText: "", emitted: false });
            }
            break;
          }
          case "tool_call_update": {
            const u = update as Record<string, unknown>;
            const toolCallId = u.toolCallId as string;
            const status = u.status as string;
            const title = (u.title ?? u.name) as string;
            const kind = u.kind as string;
            const rawInput = (u.rawInput ?? u.input ?? u.parameters) as Record<string, unknown> | undefined;
            const output = (u.rawOutput ?? u.output) as string | undefined;

            if (status !== "completed" && status !== "failed") {
              // Mid-stream update — buffer args from content
              const pt = pendingTools.get(toolCallId);
              if (pt && !pt.emitted) {
                const buffered = extractArgsFromContent(u);
                if (buffered) pt.argsText = buffered;
              }
              return;
            }

            // Completed — emit deferred tool use if needed
            closeThinkingIfOpen();
            const pt = pendingTools.get(toolCallId);
            pendingTools.delete(toolCallId);

            if (!pt?.emitted) {
              const toolName = pt?.toolName ?? toolNameFromTitle(title ?? "", kind ?? "");
              // 优先级:之前缓冲的 input → 缓冲的 argsText → 完成包里的
              // rawInput → 完成包 content 里的 text → "(no args)"
              let argsRepr: string;
              if (pt?.input) argsRepr = JSON.stringify(pt.input);
              else if (pt?.argsText) argsRepr = pt.argsText;
              else if (rawInput) argsRepr = JSON.stringify(rawInput);
              else argsRepr = extractArgsFromContent(u) ?? "(no args)";
              onOutput(`[tool:exec]${stripLeadingDollarPrompt(argsRepr)}[/tool:exec]\n`);
            }

            if (output) {
              onOutput(`[tool-result:exec]${output.slice(0, 500)}${output.length > 500 ? "..." : ""}[/tool-result:exec]\n`);
            }
            break;
          }
          case "turn_end": {
            // ACP turn-end notification — the assistant has finished its
            // turn. Close any open thinking block and emit a terminal
            // status so the dashboard's status pill (which hoists the
            // last `[status:thinking]` tag) settles to a non-Working label
            // instead of leaving "Working" stuck above the finished reply.
            closeThinkingIfOpen();
            turnEndSeen = true;
            emitStatus(onOutput, "Answered");
            break;
          }
          // usage_update 通知 hermes 实际会发,但 payload 只有 {size, used,
          // sessionUpdate} —— 只有累计 token 和 context window size,没有
          // input/output 拆分。usage 的来源走 stderr parser(see below):
          //   agent.conversation_loop: API call #N: in=X out=Y total=Z
          // 那行有 input/output 拆分,信息更全。不要在这里再写 capturedUsage,
          // 否则会覆盖 stderr parser 累积的好数据。
          default: {
            // 新版 hermes 可能引入了我们还没适配的 update 类型；如果它包含
            // 文本内容（content.text），直接当成 message chunk 透传，避免
            // 用户看到"思考完就卡住"。同时打日志方便后续根因。
            const obj = update as Record<string, unknown>;
            const rawKey = (obj.sessionUpdate as string) ?? (obj.type as string) ?? Object.keys(obj)[0] ?? "(none)";
            const content = obj.content as Record<string, unknown> | undefined;
            const text = content?.text as string | undefined;
            if (typeof text === "string" && text) {
              closeThinkingIfOpen();
              fullOutput += text;
              onOutput(text);
              console.warn(`[hermes-cli] unhandled update "${rawKey}" with text — passthrough (${text.length} chars)`);
            } else {
              console.warn(`[hermes-cli] unhandled update "${rawKey}" keys=${Object.keys(obj).join(",")}`);
            }
            break;
          }
        }
      }

      // ── Wire up stdout reader ──
      // (The transport owns the readline loop above; it routes each frame
      //  into onRequest → handleAgentRequest or onNotification → handleNotification.)

      // ── stderr logging + provider error sniffing ──

      // ── stderr logging + provider error sniffing + usage extraction ──
      // 用 readline 按行 buffer(stderr 的 data 事件按 chunk 来,一条日志
      // 被劈成两半时正则匹配不上)。

      const stderrRl = createInterface({ input: proc.stderr! });
      stderrRl.on("line", (line: string) => {
        const text = line.trim();
        if (!text) return;
        console.error(`[hermes-cli] stderr: ${text}`);
        // Sniff for terminal provider/model errors. hermes logs the same
        // failure at WARNING/ERROR level on stderr (see
        // agent.conversation_loop), so we can flip the flag from the
        // first line that matches — usually well before the
        // agent_message_chunk carrying the user-facing summary arrives.
        if (!providerError.matched && matchProviderError(text)) {
          providerError = { matched: true, message: extractCleanErrorReason(text) };
          emitStatus(onOutput, "Failed");
          console.error(`[hermes-cli] provider error detected in stderr: ${text}`);
        }
        // 从 hermes adapter 自己的 stderr 日志抽 model + usage(ACP 协议
        // 不发 usage_update 通知,这些只在 adapter 的日志里)。两行关键:
        //   agent.turn_context: ... model=deepseek-v4-flash provider=custom ...
        //   agent.conversation_loop: API call #1: model=... in=18059 out=321 total=18380 ...
        // 每个 API call 累加进 capturedUsage,最终值就是整个 issue 执行的累计。
        const turnMatch = text.match(/agent\.turn_context:.*\bmodel=(\S+)/);
        if (turnMatch && !capturedModel) capturedModel = turnMatch[1];
        const apiMatch = text.match(/agent\.conversation_loop:\s*API call #\d+:\s*model=(\S+).*?\bin=(\d+)\s+out=(\d+)\s+total=(\d+)/);
        if (apiMatch) {
          if (!capturedModel) capturedModel = apiMatch[1];
          const inN = parseInt(apiMatch[2], 10);
          const outN = parseInt(apiMatch[3], 10);
          // hermes 的 in= 是 input tokens,out= 是 output tokens,total= 是
          // input+output。累加,因为一个 turn 可能多次 API call。
          capturedUsage = {
            inputTokens: (capturedUsage?.inputTokens ?? 0) + inN,
            outputTokens: (capturedUsage?.outputTokens ?? 0) + outN,
          };
        }
      });

      // ── ACP lifecycle ──

      async function runLifecycle(): Promise<void> {
        try {
          // 1. Initialize
          await request("initialize", {
            protocolVersion: 1,
            clientInfo: { name: "open-a2a-gateway", version: "0.1.0" },
            clientCapabilities: {},
          });

          // 2. Create or resume session
          if (resumeSessionId) {
            replayActive = true;
            let resumeResult: Record<string, unknown> | undefined;
            try {
              resumeResult = (await request("session/resume", {
                cwd: workingDir || ".",
                sessionId: resumeSessionId,
              })) as Record<string, unknown>;
            } finally {
              // 不管 resume 成不成功都关掉，避免后续 live update 被误吞。
              replayActive = false;
            }

            // Server may return a different sessionId if the original was lost
            sessionId = (resumeResult?.sessionId as string) || resumeSessionId;
            console.log(`[hermes-cli] session resumed: ${sessionId}${sessionId !== resumeSessionId ? ` (original: ${resumeSessionId})` : ""}`);
          } else {
            const sessionResult = (await request("session/new", {
              cwd: workingDir || ".",
              mcpServers: [],
            })) as Record<string, unknown>;

            sessionId = (sessionResult?.sessionId as string) ?? "";
            if (!sessionId) {
              console.error("[hermes-cli] session/new returned no session ID");
            }
            console.log(`[hermes-cli] session created: ${sessionId}`);
          }

          // 3. Send prompt
          // prompt 已经由 worker 用 composePrompt() 拼好,executor 不再二次包装。
          await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: prompt }],
          });
        } catch (err) {
          console.error(`[hermes-cli] ACP lifecycle error: ${(err as Error).message}`);
        } finally {
          proc.stdin!.end();
        }
      }

      proc.on("close", (code) => {
        finish(code ?? 1);
      });

      proc.on("error", (err) => {
        console.error(`[hermes-cli] Spawn error: ${err.message}`);
        finish(1);
      });

      void runLifecycle();
    });
  }

  /**
   * Read the tail of a hermes session from its on-disk transcript at
   *   `~/.hermes/sessions/session_<sessionId>.json`
   * The file is a single JSON document with `{ messages: [{role, content}, …] }`.
   * We render the last N messages as `role: text` blocks so the dashboard
   * `<pre>` view stays readable — the raw JSON would be too noisy.
   *
   * Tolerant of missing files (hermes may prune its sessions directory) —
   * returns empty content + an explanatory `error` so the dashboard can
   * distinguish "file gone" from "session started but no messages yet".
   */
  async readSessionContent(args: {
    sessionId: string;
    workingDir: string;
    tailLines?: number;
  }): Promise<{ format: "jsonl" | "text" | "raw"; content: string; error?: string }> {
    const file = path.join(
      os.homedir(),
      ".hermes",
      "sessions",
      `session_${args.sessionId}.json`,
    );
    if (!fs.existsSync(file)) {
      return {
        format: "text",
        content: "",
        error: "hermes session 文件不存在（可能已被 hermes daemon 清理）",
      };
    }
    let parsed: { messages?: Array<{ role?: string; content?: unknown }> };
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return {
        format: "text",
        content: "",
        error: "hermes session 文件存在但 JSON 解析失败",
      };
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const tail = args.tailLines ?? 200;
    const window = messages.length > tail ? messages.slice(-tail) : messages;
    const rendered = window
      .map((m) => `[${m.role ?? "?"}] ${stringifyContent(m.content)}`)
      .join("\n\n");
    return { format: "text", content: rendered };
  }
}

// ── Hermes content rendering ────────────────────────────────────────────

/**
 * Coerce a hermes message `content` (string | array-of-blocks | object) into
 * a printable single string. We keep this conservative — anything we don't
 * recognise falls back to JSON.stringify so nothing is silently dropped.
 */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === "object") {
          const rec = b as Record<string, unknown>;
          if (typeof rec.text === "string") return rec.text;
        }
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content ?? "");
}
