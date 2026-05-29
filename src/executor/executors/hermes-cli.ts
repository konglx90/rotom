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

// ── Skill hint loader ────────────────────────────────────────────────────
//
// 新版 hermes ACP 适配器去掉了 `/skills xxx` 这条 slash command
// （acp_adapter/server.py:_handle_slash_command 只剩 help/model/tools/... 白名单），
// 我们以前那种 `/skills rotom-a2a-communicate ${prompt}` 直接发会被原样灌给
// LLM，让它把整串当成"用户要我查看 skill 文件"，跑题严重。
//
// 改成"按需 hint"：在 chat/collab 的 prompt 前面拼一小段 description
// （从 SKILL.md frontmatter 提取，~400 字符），告诉 LLM 这个 skill 存在、什么
// 时候用。LLM 自己决定是否调 `skill_view(name="rotom-a2a-communicate")`
// 拉完整 12KB 内容。无关问题就完全跳过加载，省 token。

const SKILL_NAME = "rotom-a2a-communicate";
const SKILL_HINT_PATHS = [
  path.join(os.homedir(), ".hermes", "skills", SKILL_NAME, "SKILL.md"),
];

let cachedSkillHint: string | null | undefined;

function loadSkillDescription(): string | null {
  if (cachedSkillHint !== undefined) return cachedSkillHint;
  for (const p of SKILL_HINT_PATHS) {
    try {
      const md = fs.readFileSync(p, "utf-8");
      const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;
      // frontmatter 里 description 可能是单行长文本，也可能是 YAML 折叠/literal
      // 块。先匹配同名键，吃到下一个顶层键或 frontmatter 结束。
      const descMatch = fmMatch[1].match(/^description:\s*(.+(?:\n[ \t]+.+)*)/m);
      if (!descMatch) continue;
      const desc = descMatch[1].trim().replace(/\s+/g, " ");
      if (desc) {
        cachedSkillHint = desc;
        return desc;
      }
    } catch {
      // file missing / unreadable — try next path
    }
  }
  cachedSkillHint = null;
  return null;
}

function buildSkillHintPrompt(userPrompt: string): string {
  const desc = loadSkillDescription();
  if (!desc) return userPrompt;
  return [
    `[可按需加载的技能 ${SKILL_NAME}]`,
    desc,
    `若本次请求涉及上述场景，先调用 skill_view(name="${SKILL_NAME}") 加载完整指令后再处理；否则直接回答。`,
    "",
    "---",
    "",
    userPrompt,
  ].join("\n");
}

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
              onOutput(`[tool] ${toolName}: ${JSON.stringify(rawInput)}\n`);
            } else if (contentArgs) {
              pendingTools.set(toolCallId, { toolName, argsText: contentArgs, emitted: true });
              onOutput(`[tool] ${toolName}: ${contentArgs}\n`);
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
              onOutput(`[tool] ${toolName}: ${argsRepr}\n`);
            }

            if (output) {
              onOutput(`[tool-result] ${output.slice(0, 500)}${output.length > 500 ? "..." : ""}\n`);
            }
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
          // chat/collab 走 "按需 hint" 包装：把 rotom-a2a-communicate 的
          // description 拼到 prompt 前面，由 LLM 自行判断要不要 skill_view
          // 加载完整内容。issue 路径不包装，避免 LLM 把 issue body 当成
          // 通信任务误处理（见 buildSkillHintPrompt 注释）。
          const needsCommunicationWrapper = options?.kind === "chat" || options?.kind === "collab";
          const wrappedPrompt = needsCommunicationWrapper
            ? buildSkillHintPrompt(prompt)
            : prompt;
          await request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: wrappedPrompt }],
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
}
