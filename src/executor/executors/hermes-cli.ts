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

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { CliExecutor, ExecuteOptions, ExecuteResult } from "../cli-executor.js";
import {
  createReasoningStatusBuffer,
  emitStatus,
} from "../reasoning-status.js";

// ── ACP JSON-RPC types ──────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ── Pending RPC tracking ────────────────────────────────────────────────

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

// ── Tool call buffer ────────────────────────────────────────────────────

interface PendingToolCall {
  toolName: string;
  input?: Record<string, unknown>;
  argsText: string;
  emitted: boolean;
}

// ── Executor ────────────────────────────────────────────────────────────

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

      const proc = spawn("hermes", args, {
        cwd: workingDir,
        env: {
          ...process.env,
          ...options?.env,
          PATH: mergedPath,
          HERMES_YOLO_MODE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const onAbort = () => {
        console.log(`[hermes-cli] Aborted, killing pid=${proc.pid}`);
        try { proc.kill("SIGTERM"); } catch { /* noop */ }
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* noop */ } }, 3_000);
      };
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      let fullOutput = "";
      let nextId = 1;
      const pending = new Map<number, PendingRpc>();
      const pendingTools = new Map<string, PendingToolCall>();
      let sessionId = "";
      let settled = false;
      let inThinking = false;
      // Set when we receive the ACP turn_end notification, so finish() can
      // distinguish "model finished cleanly" (already emitted "Answered")
      // from "process died before turn_end ever arrived" (needs a terminal
      // emit to keep the dashboard status pill from sticking on "Working").
      let turnEndSeen = false;
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

      // ── Helpers ──

      function send(msg: JsonRpcRequest | Record<string, unknown>): void {
        const data = JSON.stringify(msg) + "\n";
        proc.stdin!.write(data);
      }

      function request(method: string, params?: unknown): Promise<unknown> {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej, method });
          send({ jsonrpc: "2.0", id, method, params });
        });
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
        if (!turnEndSeen) {
          emitStatus(onOutput, exitCode === 0 ? "Done" : "Failed");
        }
        console.log(`[hermes-cli] Exited code=${exitCode}, output=${fullOutput.length} chars, session=${sessionId}`);
        resolve({ exitCode, fullOutput, sessionId: sessionId || undefined });
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

      function handleAgentRequest(raw: Record<string, unknown>): void {
        const method = raw.method as string;
        const rawId = raw.id;
        if (rawId == null) return;

        let resp: Record<string, unknown>;
        if (method === "session/request_permission") {
          const optionId = pickApproveOption(raw.params);
          console.log(`[hermes-cli] auto-approve permission → ${optionId}`);
          resp = {
            jsonrpc: "2.0",
            id: rawId,
            result: {
              outcome: {
                outcome: "selected",
                optionId,
              },
            },
          };
        } else {
          console.warn(`[hermes-cli] unhandled agent→client method: ${method} (params=${JSON.stringify(raw.params).slice(0, 200)})`);
          resp = {
            jsonrpc: "2.0",
            id: rawId,
            error: { code: -32601, message: `method not found: ${method}` },
          };
        }
        send(resp);
      }

      // ── Handle JSON-RPC responses ──

      function handleResponse(raw: Record<string, unknown>): void {
        const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);

        if (raw.error) {
          const err = raw.error as { code: number; message: string };
          p.reject(new Error(`${p.method}: ${err.message} (code=${err.code})`));
        } else {
          p.resolve(raw.result);
        }
      }

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

      function handleNotification(raw: Record<string, unknown>): void {
        const method = raw.method as string;
        if (method !== "session/update" && method !== "session/notification") return;

        const params = raw.params as Record<string, unknown> | undefined;
        const update = params?.update as Record<string, unknown> | undefined;
        if (!update) return;

        // session/resume 期间到达的全是历史 replay（user/assistant/thought
        // chunks 形态与 live 完全相同），直接吞掉。等 resume RPC 返回，
        // replayActive 会被置 false，后续 session/prompt 的 update 才会进 switch。
        if (replayActive) return;

        const updateType = normalizeUpdateType(update);

        switch (updateType) {
          case "agent_message_chunk": {
            const content = (update as Record<string, unknown>).content as Record<string, unknown> | undefined;
            const text = content?.text as string | undefined;
            if (text) {
              closeThinkingIfOpen();
              fullOutput += text;
              onOutput(text);
              // 模型已经从「思考」切到「回答」,状态 pill 切回 "Working"
              emitStatus(onOutput, "Working");
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

      // ── Route every line from stdout ──

      function handleLine(line: string): void {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line);
        } catch {
          return;
        }

        // Agent → client request (has id + method, no result/error yet)
        if (raw.id != null && raw.method && !("result" in raw) && !("error" in raw)) {
          handleAgentRequest(raw);
          return;
        }

        // JSON-RPC response (has id + result or error)
        if (raw.id != null && ("result" in raw || "error" in raw)) {
          handleResponse(raw);
          return;
        }

        // Notification (no id, has method)
        if (raw.method) {
          handleNotification(raw);
        }
      }

      // ── Wire up stdout reader ──

      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => handleLine(line.trim()));

      // ── stderr logging ──

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) console.error(`[hermes-cli] stderr: ${text}`);
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
