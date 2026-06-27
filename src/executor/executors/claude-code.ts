/**
 * Claude Code CLI Executor
 *
 * Spawns `claude -p --output-format stream-json --input-format stream-json`
 * and communicates via NDJSON on stdin/stdout.
 *
 * Approval gating: when the worker supplies an `onApprovalRequest` callback,
 * we set up a per-run unix-domain-socket server, write a temporary settings
 * file that wires up a `PreToolUse` hook (`claude-code-hook.cjs`), and let
 * claude funnel every Bash/Edit/Write/MultiEdit/NotebookEdit call through
 * the human in the dashboard. When no callback is supplied we keep the
 * legacy `bypassPermissions` behavior so non-interactive callers still work.
 *
 * `onApprovalRequest` is always supplied by the worker. For `rw_allow`
 * the callback auto-accepts immediately; for `r_allow` it awaits Dashboard
 * user decision. Either way the PreToolUse hook is always installed,
 * preventing Claude Code's own permission prompts from hanging on closed
 * stdin.
 */

import { runProcess } from "../process-runner.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalDecision, ApprovalRequestInput, AskUserQuestionItem, CliExecutor, ExecuteOptions, ExecuteResult, FileEditDiff, TokenUsage } from "../cli-executor.js";
import type { TodoItem } from "../../shared/protocol.js";
import { emitStatus } from "../reasoning-status.js";

// Resolve the bundled hook script. After `tsc` the .cjs file is copied next
// to the compiled module (see package.json `build` script). In `tsx` dev
// mode the source path also works.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function locateHookScript(): string {
  const candidates = [
    // dist/executor/executors/ → dist/executor/claude-code-hook.cjs
    path.resolve(__dirname, "..", "claude-code-hook.cjs"),
    // src/executor/executors/ → src/executor/claude-code-hook.cjs (tsx dev)
    path.resolve(__dirname, "..", "..", "src", "executor", "claude-code-hook.cjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Let the caller fail loudly with a useful message.
  return candidates[0];
}

const HOOK_TOOL_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit|ExitPlanMode|AskUserQuestion";

/**
 * 把 cwd 转成 Claude Code 在 ~/.claude/projects/ 下的子目录名。
 * 编码规则(从实际目录观察): 绝对路径里的 `/` 和 `.` 全部替换为 `-`。
 *   /Users/kong/ai-work/rotom  → -Users-kong-ai-work-rotom
 *   /Users/kong/.rotom/artifacts → -Users-kong--rotom-artifacts
 */
function claudeProjectDir(cwd: string): string {
  const resolved = path.resolve(cwd);
  const encoded = resolved.replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

/**
 * Claude Code 的 `--resume <id>` 要求该 session 已经存在于当前 cwd 对应的项目
 * 目录中(<project>/<id>.jsonl);否则会抛 "No conversation found..."。首次进入
 * 一个新的工作目录时必须改用 `--session-id <uuid>` 来"创建并使用"。
 */
function claudeSessionExists(cwd: string, sessionId: string): boolean {
  try {
    return fs.existsSync(path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

export class ClaudeCodeExecutor implements CliExecutor {
  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const resumeSessionId = options?.sessionId;
      const approvalGate = options?.onApprovalRequest
        ? createApprovalGate(options.onApprovalRequest)
        : null;

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
        // 默认 bypassPermissions：让 PreToolUse hook 完整接管审批决策；hook 不存在
        // 时由 claude 自行放行，符合后台无人值守语义。
        // 当 slashCommand === "/plan" 时切到 claude 原生 plan 模式：claude 会先
        // 输出方案并通过 ExitPlanMode 触发审批，复用既有 kind:"plan" 审批链路。
        "--permission-mode", options?.slashCommand === "/plan" ? "plan" : "bypassPermissions",
      ];
      if (approvalGate) {
        args.push("--settings", approvalGate.settingsPath);
      }

      let sessionMode: "resume" | "session-id" | "new" = "new";
      if (resumeSessionId) {
        if (claudeSessionExists(workingDir, resumeSessionId)) {
          args.push("--resume", resumeSessionId);
          sessionMode = "resume";
        } else {
          // 调用方期望复用这个 sessionId,但该 cwd 下还没有它对应的 jsonl。
          // 用 --session-id 创建一个新的对话并把 ID 固定下来,这样下次再传同
          // 一个 ID 进来时就能走到上面的 --resume 分支。
          args.push("--session-id", resumeSessionId);
          sessionMode = "session-id";
        }
      }

      const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...options?.env };
      if (approvalGate) {
        spawnEnv.ROTOM_APPROVAL_SOCKET = approvalGate.socketPath;
        spawnEnv.ROTOM_APPROVAL_TOKEN = approvalGate.token;
      }
      console.log(`[claude-code] Spawning claude (cwd: ${workingDir}, session: ${resumeSessionId ? `${sessionMode}=${resumeSessionId}` : "new"}, ROTOM_AGENT=${spawnEnv.ROTOM_AGENT}, ROTOM_HOME=${spawnEnv.ROTOM_HOME}, gate=${approvalGate ? "on" : "off"})`);

      const { proc } = runProcess({
        bin: "claude",
        args,
        cwd: workingDir,
        env: spawnEnv as Record<string, string>,
        label: "claude-code",
        signal: options?.signal,
      });

      // Write structured input (stream-json format)
      // prompt 已经由 worker 用 composePrompt() 拼好(rotom-cli + agent-role +
      // group-basic + cwd + task),executor 不再二次包装,直接喂给 CLI。
      const inputPayload = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      }) + "\n";
      proc.stdin!.write(inputPayload);
      proc.stdin!.end();

      let fullOutput = "";
      let sessionId = "";
      let failed = false;
      let capturedUsage: TokenUsage | undefined;
      let capturedModel: string | undefined;
      // tool_use_id → tag bucket。assistant 阶段记下每个工具属于 exec 还是
      // patch / ask / todo 类,user 阶段拿 tool_result 时按同一 id 决定是否要推
      // [tool-result:exec]（patch / ask / todo 类没有配对的 result tag,要么单独
      // 走 [tool-result:ask],要么直接吞掉）。
      const toolUseKinds = new Map<string, "exec" | "patch" | "ask" | "todo">();

      // 把跨 chunk 的 NDJSON records 在 buffer 里累积,避免一条很长的 record
      // (如 `Read` 1000 行 diff 后 user tool_result 有 77k 字符)被 stream chunk
      // 边界切断 → split("\n") 切出半截 record → JSON.parse 失败 → 落到 catch
      // 分支被原样 onOutput → 整条 77k 字符 raw record 塞进 message content
      // 当成 narrative 渲染,前端无法折叠。
      let stdoutBuffer = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        // 找最后一个 \n,把 buffer 切成 "已完成的 lines" + "残留的不完整 tail"。
        // \r\n 也兼容(去掉 \r),NDJSON 通常用 \n,但 Windows/某些 tty 配置可能 \r\n。
        const lastNl = stdoutBuffer.lastIndexOf("\n");
        if (lastNl === -1) return; // 整个 buffer 还没攒出一条完整 line
        const completed = stdoutBuffer.slice(0, lastNl);
        stdoutBuffer = stdoutBuffer.slice(lastNl + 1);
        const lines = completed.split("\n").map(l => l.endsWith("\r") ? l.slice(0, -1) : l).filter(Boolean);
        for (const line of lines) {
          let parsed: Record<string, any> | null = null;
          try {
            parsed = JSON.parse(line);
          } catch (err) {
            // Catch 分支不再原样 onOutput —— 那会把半个或整个 raw record
            // (含 user tool_result) 当 narrative 推到 message content,无法折叠。
            // 偶尔的协议错误 warn 一下,丢掉这帧,不让它污染下游展示。
            console.warn(
              `[claude-code] skipping malformed NDJSON record (${line.length} chars): ` +
              `${(err as Error).message}`,
            );
            continue;
          }
          handleRecord(parsed!);
        }
      });

      // 处理单个 NDJSON record。把 switch 提到独立函数,粘行切分路径复用。
      function handleRecord(parsed: Record<string, any>): void {
        switch (parsed.type) {
            case "system":
              if (parsed.session_id && !sessionId) {
                sessionId = parsed.session_id;
              }
              break;

            case "assistant":
              // assistant 事件的 message.usage 是**当前轮** token(input +
              // output + cache 读写),不是跨多轮累积。worker 端做累积。
              // 字段映射与下方 result 分支(line 290-296)保持一致,避免两
              // 处不同步。终态时 worker 用 result.usage 覆盖内存累积值,
              // 保证 reload 后看到的 issue.usage 与最后一次推送一致。
              if (parsed.message?.usage && options?.onUsage) {
                const u = parsed.message.usage as Record<string, unknown>;
                const increment: TokenUsage = {
                  inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
                  outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
                  cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
                  cacheCreationTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
                };
                // 至少有一个有效字段才推,避免空对象打爆节流队列
                if (
                  increment.inputTokens != null
                  || increment.outputTokens != null
                  || increment.cacheReadTokens != null
                  || increment.cacheCreationTokens != null
                ) {
                  try { options.onUsage(increment); } catch { /* swallow callback errors */ }
                }
              }
              if (parsed.message?.content) {
                emitStatus(onOutput, "Working");
                for (const block of parsed.message.content) {
                  if (block.type === "text" && block.text) {
                    fullOutput += block.text;
                    onOutput(block.text);
                  } else if (block.type === "tool_use" && typeof block.name === "string") {
                    // TodoWrite:结构化上报,不走 [tool:exec] 卡片。dashboard
                    // 会读 issue.latest_todos 单独渲染常驻面板,时间线也只出
                    // 一条极轻量 chip 事件。把 id 登记为 "todo" kind,后续
                    // tool_result 也跳过(避免截断 500 字的"Todos written"噪声)。
                    if (block.name === "TodoWrite" && options?.onTodos) {
                      const rawTodos = (block.input ?? {}) as { todos?: unknown };
                      const todos = normalizeTodos(rawTodos.todos);
                      if (todos) {
                        if (typeof block.id === "string") {
                          toolUseKinds.set(block.id, "todo");
                        }
                        try { options.onTodos(todos); } catch { /* swallow callback errors */ }
                        continue;
                      }
                    }
                    const { kind, label } = describeToolUseForLog(
                      block.name,
                      (block.input ?? {}) as Record<string, unknown>,
                    );
                    if (typeof block.id === "string") {
                      toolUseKinds.set(block.id, kind);
                    }
                    if (kind === "patch") {
                      onOutput(`[tool:patch]${label}[/tool:patch]\n`);
                      emitStatus(onOutput, "Patching");
                    } else if (kind === "ask") {
                      onOutput(`[tool:ask]${label}[/tool:ask]\n`);
                      emitStatus(onOutput, "Asking");
                    } else {
                      onOutput(`[tool:exec]${label}[/tool:exec]\n`);
                      emitStatus(onOutput, "Running");
                    }
                  }
                }
              }
              break;

            case "user":
              // claude 把 tool_result 包在 user 消息里回吐。patch 类（Edit/Write/
              // MultiEdit/NotebookEdit）dashboard 上只展示动作不展示结果，跳过；
              // todo 类(TodoWrite)结果就是一句 "Todos written" 之类,完全不展示；
              // exec 类则截断后包成 [tool-result:exec] 与上一条 [tool:exec] 配对。
              if (parsed.message?.content) {
                for (const block of parsed.message.content) {
                  if (block.type !== "tool_result") continue;
                  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
                  const kind = toolUseId ? toolUseKinds.get(toolUseId) : undefined;
                  if (kind === "ask") {
                    const text = flattenToolResultContent(block.content);
                    if (text) onOutput(`[tool-result:ask]${text}[/tool-result:ask]\n`);
                    emitStatus(onOutput, "Answered");
                    continue;
                  }
                  if (kind === "todo") continue;
                  if (kind !== "exec") continue;
                  const text = flattenToolResultContent(block.content);
                  if (!text) continue;
                  const truncated = text.length > TOOL_RESULT_MAX_CHARS
                    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}...`
                    : text;
                  onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
                  // claude 的 tool_result block 不携带 exit_code；默认当
                  // "Done",后续 assistant 块来时会被 "Working" 覆盖。
                  const isError = block.is_error === true;
                  emitStatus(onOutput, isError ? "Failed" : "Done");
                }
              }
              break;

            case "result":
              if (parsed.session_id) {
                sessionId = parsed.session_id;
              }
              if (typeof parsed.model === "string" && parsed.model) {
                capturedModel = parsed.model;
              }
              const usageRaw = parsed.usage;
              if (usageRaw && typeof usageRaw === "object") {
                const u = usageRaw as Record<string, unknown>;
                capturedUsage = {
                  inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
                  outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
                  cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
                  cacheCreationTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
                  totalCostUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
                };
              }
              const text = parsed.result || "";
              if (text) {
                fullOutput = text;
              }
              if (parsed.is_error) {
                failed = true;
                emitStatus(onOutput, "Failed");
              } else {
                emitStatus(onOutput, "Answered");
              }
              break;
          }
      }

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text && !text.startsWith("Warning:") && !text.startsWith("Note:")) {
          console.error(`[claude-code] stderr: ${text}`);
        }
      });

      proc.on("close", (code) => {
        // Flush stdoutBuffer 残留的尾部(没有以 \n 结尾的最后一条 record)。
        // 正常情况 on("data") 已经处理完所有完整行,这里只处理尾巴。
        if (stdoutBuffer.length > 0) {
          try {
            handleRecord(JSON.parse(stdoutBuffer));
          } catch (err) {
            console.warn(
              `[claude-code] skipping trailing NDJSON record (${stdoutBuffer.length} chars): ` +
              `${(err as Error).message}`,
            );
          }
          stdoutBuffer = "";
        }
        // If resume was requested but claude returned a different session id
        // AND the run failed, the resume did not land — clear sessionId so
        // the caller can retry with a fresh session.
        const reportedSessionId = resolveSessionId(
          resumeSessionId ?? "",
          sessionId,
          failed,
        );

        if (approvalGate) approvalGate.cleanup();

        console.log(`[claude-code] Exited code=${code}, output=${fullOutput.length} chars, session=${reportedSessionId}`);
        resolve({
          exitCode: code ?? 1,
          fullOutput,
          sessionId: reportedSessionId || undefined,
          usage: capturedUsage,
          model: capturedModel,
        });
      });

      proc.on("error", (err) => {
        console.error(`[claude-code] Spawn error: ${err.message}`);
        if (approvalGate) approvalGate.cleanup();
        resolve({ exitCode: 1, fullOutput, sessionId: sessionId || undefined, usage: capturedUsage, model: capturedModel });
      });
    });
  }

  /**
   * Read the tail of `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
   * Each line is a JSON record (user/assistant/tool messages, system events,
   * …). We return the last N lines verbatim — the dashboard renders them as
   * a `<pre>` block. Future enhancement: pretty-print parsed records.
   *
   * Tolerant of missing files (returns empty content) so a "view session"
   * click never 500s on a pruned transcript.
   */
  async readSessionContent(args: {
    sessionId: string;
    workingDir: string;
    tailLines?: number;
  }): Promise<{ format: "jsonl" | "text" | "raw"; content: string }> {
    const file = path.join(claudeProjectDir(args.workingDir), `${args.sessionId}.jsonl`);
    if (!fs.existsSync(file)) {
      return { format: "jsonl", content: "" };
    }
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n");
    const tail = args.tailLines ?? 200;
    const sliced = lines.length > tail ? lines.slice(-tail).join("\n") : text;
    return { format: "jsonl", content: sliced };
  }
}

/**
 * Decide which session id to report. When resume was requested but claude
 * emitted a fresh, different session id AND the run failed, the resume did
 * not land (claude printed "No conversation found..." to stderr, generated a
 * fresh session, and exited). Return "" so the caller can retry fresh.
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

// ── Approval gate (PreToolUse hook bridge) ──────────────────────────────

interface ApprovalGate {
  socketPath: string;
  settingsPath: string;
  token: string;
  cleanup: () => void;
}

/**
 * Stand up a one-shot unix-domain-socket server + temporary settings.json so
 * claude's PreToolUse hook can ask us for permission. Returns the artifacts
 * the executor needs to pass through to claude (socket path via env,
 * settings path via --settings) plus a cleanup that tears the server down
 * and removes the temp files.
 */
function createApprovalGate(
  onApprovalRequest: (req: ApprovalRequestInput) => Promise<ApprovalDecision>,
): ApprovalGate {
  const id = randomUUID();
  const token = randomUUID();
  // Unix socket paths are length-limited (~104 chars on macOS). Keep names
  // short and lean on os.tmpdir(), which is typically /var/folders/... or
  // /tmp on linux.
  const socketPath = path.join(os.tmpdir(), `rotom-cc-${id.slice(0, 8)}.sock`);
  const settingsPath = path.join(os.tmpdir(), `rotom-cc-${id.slice(0, 8)}.settings.json`);

  // Defensive: a leftover socket from a previous crash would refuse listen.
  try { fs.unlinkSync(socketPath); } catch { /* fine, didn't exist */ }

  const hookScript = locateHookScript();
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: HOOK_TOOL_MATCHER,
          hooks: [
            { type: "command", command: `node ${JSON.stringify(hookScript)}` },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const server: Server = createServer((req, res) => {
    // Auth: hooks send the token we minted; without it we 401. Helps when
    // some unrelated local process stumbles onto the socket.
    if (req.headers["x-rotom-token"] !== token) {
      res.statusCode = 401;
      res.end("invalid token");
      return;
    }
    if (req.method !== "POST" || req.url !== "/approval") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      void (async () => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(body || "{}"); } catch { /* keep empty */ }
        const toolName = String(payload.tool_name || "");
        const toolInput = (payload.tool_input || {}) as Record<string, unknown>;
        const input = describeToolCall(toolName, toolInput);

        let result: ApprovalDecision = { decision: "deny" };
        let reason = "User denied via dashboard";
        try {
          result = await onApprovalRequest(input);
          if (input.kind === "ask") {
            // AskUserQuestion: the user "answers" by submitting a deny with
            // structured feedback. We surface the answer to claude as the
            // permissionDecisionReason so the model treats it as the user's
            // reply (the underlying tool call is still denied — claude reads
            // the reason text and continues with the supplied answer).
            const answer = result.decision === "deny" ? result.feedback?.trim() : undefined;
            reason = answer
              ? `[AskUserQuestion 用户答复]\n${answer}`
              : `[AskUserQuestion 用户答复] (用户未填写答案)`;
          } else if (result.decision === "accept") {
            reason = "User accepted via dashboard";
          } else if (result.feedback?.trim()) {
            reason = `User denied via dashboard: ${result.feedback.trim()}`;
          }
        } catch (err) {
          reason = `approval callback error: ${(err as Error).message}`;
        }

        const responseBody = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: result.decision === "accept" ? "allow" : "deny",
            permissionDecisionReason: reason,
          },
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(responseBody);
      })();
    });
  });

  server.listen(socketPath);
  // Permissions: only the user running this process should be able to talk
  // to the socket. tmpdir on macOS is per-user already, but be explicit.
  try { fs.chmodSync(socketPath, 0o600); } catch { /* socket may already be gone */ }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { server.close(); } catch { /* noop */ }
    try { fs.unlinkSync(socketPath); } catch { /* may already be gone */ }
    try { fs.unlinkSync(settingsPath); } catch { /* may already be gone */ }
  };

  return { socketPath, settingsPath, token, cleanup };
}

// ── Tool-call streaming helpers ─────────────────────────────────────────
//
// Map claude's stream-json tool_use / tool_result blocks onto the same tag
// vocabulary codex emits, so dashboard/MarkdownContent.tsx can render them as
// tool-call cards. Write-class tools (Edit/Write/MultiEdit/NotebookEdit) go to
// [tool:patch] (no result); everything else (Bash, Read, Grep, Glob,
// WebFetch, Task, TodoWrite, ...) goes to [tool:exec] + [tool-result:exec].

const PATCH_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TOOL_RESULT_MAX_CHARS = 500;
// 单次 [tool:patch] 标签 body 上限。Write 一个 5000 行文件能轻松超过 200KB,
// 浏览器 PatchBlock 渲染会卡;前端只是回看场景,截断到 ~50KB 已足够看清结构。
const PATCH_LOG_MAX_BYTES = 50_000;

/** Build a unified-diff-like body for Edit/Write/MultiEdit/NotebookEdit so
 *  the timeline's PatchBlock can render add/remove lines instead of just a
 *  file path. Not a real unified diff (no line numbers / no context), but
 *  the +/- markers + filename headers are enough for visual review. */
function buildPatchLogBody(name: string, input: Record<string, unknown>): string {
  const filePath =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.notebook_path === "string" && input.notebook_path) ||
    "(unknown file)";
  const out: string[] = [];
  const pushMinus = (s: string) => { for (const line of s.split("\n")) out.push(`-${line}`); };
  const pushPlus = (s: string) => { for (const line of s.split("\n")) out.push(`+${line}`); };

  if (name === "Edit") {
    const oldS = typeof input.old_string === "string" ? input.old_string : "";
    const newS = typeof input.new_string === "string" ? input.new_string : "";
    out.push(`--- ${filePath}`, `+++ ${filePath}`, `@@ Edit @@`);
    pushMinus(oldS);
    pushPlus(newS);
  } else if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    out.push(`--- ${filePath}`, `+++ ${filePath}`);
    edits.forEach((e, idx) => {
      const rec = (e ?? {}) as Record<string, unknown>;
      const oldS = typeof rec.old_string === "string" ? rec.old_string : "";
      const newS = typeof rec.new_string === "string" ? rec.new_string : "";
      out.push(`@@ MultiEdit ${idx + 1}/${edits.length} @@`);
      pushMinus(oldS);
      pushPlus(newS);
    });
  } else if (name === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    out.push(`--- /dev/null`, `+++ ${filePath}`, `@@ Write @@`);
    pushPlus(content);
  } else {
    // NotebookEdit
    const src = typeof input.new_source === "string" ? input.new_source : "";
    out.push(`--- ${filePath}`, `+++ ${filePath}`, `@@ NotebookEdit @@`);
    pushPlus(src);
  }

  let body = out.join("\n");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > PATCH_LOG_MAX_BYTES) {
    body = body.slice(0, Math.floor(body.length * PATCH_LOG_MAX_BYTES / bytes))
      + "\n... (truncated, full diff in the approval card)";
  }
  return body;
}

function describeToolUseForLog(
  name: string,
  input: Record<string, unknown>,
): { kind: "exec" | "patch" | "ask"; label: string } {
  if (PATCH_TOOLS.has(name)) {
    return { kind: "patch", label: buildPatchLogBody(name, input) };
  }
  if (name === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    return { kind: "ask", label: JSON.stringify({ questions }) };
  }
  if (name === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return { kind: "exec", label: command || "(empty command)" };
  }
  if (name === "Read") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    return { kind: "exec", label: filePath ? `Read ${filePath}` : "Read" };
  }
  if (name === "Grep" || name === "Glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const pathSuffix = typeof input.path === "string" && input.path ? ` ${input.path}` : "";
    return { kind: "exec", label: pattern ? `${name} ${pattern}${pathSuffix}` : name };
  }
  return { kind: "exec", label: name };
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * 把 Claude Code TodoWrite tool_use 的 input.todos 数组规范化成 TodoItem[]。
 *
 * claude 输出可能有两种异常需要兜底:
 *  - tool_use 流式期间 input 字段可能还在拼接(早期 chunk),JSON 部分字段缺失
 *  - 数组里的项 status 字段值不在三选一时,映射到最近的合法值
 *
 * 返回 null 表示这次输入还没凑齐(或者格式完全错乱),调用方应忽略不要触发回调。
 * 这样能容忍流式过程中的"半成品" input,只在拿到完整 tool_use 时上报。
 */
function normalizeTodos(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const content = typeof r.content === "string" ? r.content : "";
    if (!content) continue;
    const statusRaw = typeof r.status === "string" ? r.status : "pending";
    const status: TodoItem["status"] =
      statusRaw === "in_progress" ? "in_progress" :
      statusRaw === "completed" ? "completed" :
      "pending";
    const activeForm = typeof r.activeForm === "string" && r.activeForm ? r.activeForm : undefined;
    out.push({ content, status, ...(activeForm ? { activeForm } : {}) });
  }
  if (out.length === 0) return null;
  return out;
}

const MAX_DIFF_CONTENT_BYTES = 50_000;

function truncateForDiff(str: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(str, "utf8");
  if (bytes <= maxBytes) return { text: str, truncated: false };
  const truncated = str.slice(0, Math.floor(str.length * maxBytes / bytes));
  return { text: truncated + "\n... (truncated)", truncated: true };
}

/**
 * Translate a claude PreToolUse payload into the worker-facing approval
 * input shape (the same one codex produces). Bash → exec; the edit/write
 * family → file_change.
 */
function describeToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): ApprovalRequestInput {
  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const cwd = typeof toolInput.cwd === "string" ? toolInput.cwd : undefined;
    const description = typeof toolInput.description === "string" ? toolInput.description : "";
    const summary = description
      ? `请求执行命令：${description}`
      : command
        ? `请求执行命令：${command.length > 200 ? command.slice(0, 200) + "…" : command}`
        : "请求执行 shell 命令";
    return { kind: "exec", summary, command: command || undefined, cwd };
  }
  if (toolName === "AskUserQuestion") {
    const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
    const questions: AskUserQuestionItem[] = rawQuestions
      .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
      .map((q) => ({
        question: typeof q.question === "string" ? q.question : "",
        header: typeof q.header === "string" ? q.header : "",
        multiSelect: Boolean(q.multiSelect),
        options: Array.isArray(q.options)
          ? q.options
              .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
              .map((o) => ({
                label: typeof o.label === "string" ? o.label : "",
                description: typeof o.description === "string" ? o.description : "",
              }))
          : [],
      }));
    const headline = questions[0]?.question || "AskUserQuestion";
    const more = questions.length > 1 ? `（+${questions.length - 1} 个问题）` : "";
    return {
      kind: "ask",
      summary: `请求询问用户：${headline.length > 80 ? headline.slice(0, 80) + "…" : headline}${more}`,
      questions,
    };
  }
  if (toolName === "ExitPlanMode") {
    const plan = typeof toolInput.plan === "string" ? toolInput.plan : "";
    const firstLine = plan.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    const headline = firstLine.replace(/^#+\s*/, "");
    const summary = headline
      ? `请求确认方案：${headline.length > 80 ? headline.slice(0, 80) + "…" : headline}`
      : "请求确认方案";
    return { kind: "plan", summary, plan: plan || undefined };
  }

  // Edit / Write / MultiEdit / NotebookEdit
  const filePath = typeof toolInput.file_path === "string"
    ? toolInput.file_path
    : typeof toolInput.notebook_path === "string"
      ? toolInput.notebook_path
      : "";
  const files = filePath ? [filePath] : [];

  let diff: FileEditDiff | undefined;
  let summary: string;

  if (toolName === "Edit") {
    const oldStr = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
    const newStr = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
    const { text: oldT, truncated: t1 } = truncateForDiff(oldStr, MAX_DIFF_CONTENT_BYTES);
    const { text: newT, truncated: t2 } = truncateForDiff(newStr, MAX_DIFF_CONTENT_BYTES);
    diff = { tool: toolName, hunks: [{ old_string: oldT, new_string: newT }], truncated: t1 || t2 };
    const lines = oldStr.split("\n").length;
    summary = filePath
      ? `请求编辑文件：${filePath} (${lines} 行)`
      : "请求编辑文件";
  } else if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    let anyTruncated = false;
    const hunks = edits.map((e: Record<string, unknown>) => {
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      const newStr = typeof e.new_string === "string" ? e.new_string : "";
      const { text: o, truncated: t1 } = truncateForDiff(oldStr, MAX_DIFF_CONTENT_BYTES);
      const { text: n, truncated: t2 } = truncateForDiff(newStr, MAX_DIFF_CONTENT_BYTES);
      if (t1 || t2) anyTruncated = true;
      return { old_string: o, new_string: n };
    });
    diff = { tool: toolName, hunks, truncated: anyTruncated };
    summary = filePath
      ? `请求批量编辑文件：${filePath} (${edits.length} 处修改)`
      : `请求批量编辑文件`;
  } else if (toolName === "Write") {
    const content = typeof toolInput.content === "string" ? toolInput.content : "";
    const { text, truncated } = truncateForDiff(content, MAX_DIFF_CONTENT_BYTES);
    diff = { tool: toolName, hunks: [], new_content: text, truncated };
    summary = filePath
      ? `请求写入文件：${filePath} (${content.length.toLocaleString()} 字符)`
      : "请求写入文件";
  } else {
    // NotebookEdit
    const newSource = typeof toolInput.new_source === "string" ? toolInput.new_source : "";
    const { text, truncated } = truncateForDiff(newSource, MAX_DIFF_CONTENT_BYTES);
    diff = { tool: toolName, hunks: [], new_content: text, truncated };
    const verb = "编辑";
    summary = filePath
      ? `请求${verb}文件：${filePath}`
      : `请求${verb}文件`;
  }

  return { kind: "file_change", summary, files: files.length ? files : undefined, diff };
}
