/**
 * Codex CLI Executor
 *
 * Spawns `codex app-server --listen stdio://` and drives the Codex JSON-RPC 2.0
 * protocol over stdin/stdout. Mirrors Multica's Go reference implementation in
 * server/pkg/agent/codex.go.
 *
 * Lifecycle:
 *   1. initialize handshake
 *   2. `initialized` notification
 *   3. thread/start (or thread/resume when sessionId is given) → threadId
 *   4. turn/start with threadId + prompt
 *   5. wait for turn/completed (raw v2) or task_complete (legacy codex/event)
 *
 * Two notification dialects are supported:
 *   • Legacy: { method: "codex/event", params: { msg: { type, ... } } }
 *   • Raw v2: { method: "turn/started" | "turn/completed" | "item/<phase>", ... }
 *
 * Server-initiated approval requests:
 *   • exec / file change → routed to options.onApprovalRequest when provided
 *     (so a human can Accept/Deny via the dashboard); otherwise auto-accepted
 *     to keep daemon-style runs unblocked.
 *   • MCP elicitation → always auto-accepted (internal protocol chatter).
 *
 * Whether `onApprovalRequest` is supplied is decided by the worker based on
 * `issue.approval_policy`: `r_allow`(默认)→ 传 callback；`rw_allow` → 不传，
 * 走 auto-accept 路径。
 */

import { runProcess } from "../process-runner.js";
import { createJsonRpcTransport, type JsonRpcTransport } from "../jsonrpc-transport.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalDecision, ApprovalRequestInput, CliExecutor, ExecuteOptions, ExecuteResult, TokenUsage } from "../cli-executor.js";
import { buildPlanModeInstruction } from "../../shared/slash-commands.js";
import { emitStatus } from "../reasoning-status.js";
import { resolveSessionId, sliceTail } from "../adapter-helpers.js";

// ── Executor ────────────────────────────────────────────────────────────

export class CodexExecutor implements CliExecutor {
  async execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const resumeSessionId = options?.sessionId || "";

      // prompt 已经由 worker 用 composePrompt() 拼好,executor 不再二次包装。

      const args = ["app-server", "--listen", "stdio://"];
      const spawnEnv = { ...process.env, ...options?.env };

      const { proc, done: procDone } = runProcess({
        bin: "codex",
        args,
        cwd: workingDir,
        env: spawnEnv as Record<string, string>,
        label: "codex",
        signal: options?.signal,
      });

      // ── Per-run state ──
      let fullOutput = "";
      let threadId = "";
      let settled = false;
      let failed = false;
      let turnError = "";
      let sessionPoisoned = false;
      let turnDoneResolve: ((aborted: boolean) => void) | null = null;
      let notificationProtocol: "unknown" | "legacy" | "raw" = "unknown";
      let turnStarted = false;
      // 终端状态去重:codex v2 协议下可能从多个路径到达终态(item/completed
      // agentMessage final_answer / turn/completed / finish()),dashboard
      // 端 hoistStatus 已经只保留最后一个 tag,但重复 emit 既浪费流量也
      // 干扰调试日志,这里用同一个 flag 集中拦截。
      let terminalEmitted = false;
      const completedTurnIds = new Set<string>();
      let capturedUsage: TokenUsage | undefined;
      let capturedModel: string | undefined;

      const turnDone = new Promise<boolean>((res) => { turnDoneResolve = res; });
      function signalTurnDone(aborted: boolean): void {
        if (turnDoneResolve) {
          const r = turnDoneResolve;
          turnDoneResolve = null;
          r(aborted);
        }
      }

      function setTurnError(msg: string): void {
        if (msg && !turnError) turnError = msg;
        // Detect the upstream OpenAI invariant violation that pins a chat
        // history forever once an assistant `tool_calls` message exists
        // without matching tool responses. Once this is set, callers should
        // drop the cached sessionId so the next run starts fresh — otherwise
        // every resume keeps replaying the poisoned history.
        if (msg && /tool[_ ]?calls?|tool[_ ]message|tool_call_id/i.test(msg)) {
          sessionPoisoned = true;
        }
      }

      // ── JSON-RPC transport (line framing + pending map + onRequest/onNotification) ──
      // The transport owns the readline loop and routes each frame to the
      // matching callback. We just plug in our domain handlers below.
      const transport: JsonRpcTransport = createJsonRpcTransport({
        stdin: proc.stdin,
        stdout: proc.stdout,
        label: "codex",
        onRequest: (method, params, id) => handleServerRequest(method, params, id),
        onNotification: (method, params) => handleNotification(method, params),
      });

      function request(method: string, params?: unknown): Promise<unknown> {
        return transport.request(method, params);
      }

      function notify(method: string, params?: unknown): void {
        transport.notify(method, params);
      }

      function respond(id: number | string, result: unknown): void {
        transport.respond(id, result);
      }

      function respondError(id: number | string, code: number, message: string): void {
        transport.respondError(id, code, message);
      }

      // ── Server → client requests (auto-approve) ──

      function handleServerRequest(method: string, rawParams: unknown, id: number | string): void {
        const params = (rawParams ?? {}) as Record<string, unknown>;
        switch (method) {
          case "item/commandExecution/requestApproval":
          case "execCommandApproval": {
            const input = extractExecApprovalInput(params);
            routeApproval(id, input);
            return;
          }
          case "item/fileChange/requestApproval":
          case "applyPatchApproval": {
            const input = extractFileApprovalInput(params);
            routeApproval(id, input);
            return;
          }
          case "mcpServer/elicitation/request":
            // MCP elicitations stay auto-accepted — they're internal protocol
            // chatter that the human user does not need to vet.
            respond(id, { action: "accept", content: null, _meta: null });
            return;
          default:
            console.warn(`[codex] unhandled server request: ${method}`);
            respondError(id, -32601, `unhandled server request: ${method}`);
        }
      }

      // Bridge to the worker's approval pipeline. If no callback is wired,
      // fall back to the legacy auto-accept so daemon contexts keep working.
      function routeApproval(id: number | string, input: ApprovalRequestInput): void {
        if (!options?.onApprovalRequest) {
          respond(id, { decision: "accept" });
          return;
        }
        // Fire-and-forget — we intentionally don't await this. codex stays
        // parked on the JSON-RPC request until we call respond() below.
        void (async () => {
          let result: ApprovalDecision = { decision: "deny" };
          try {
            result = await options.onApprovalRequest!(input);
          } catch (err) {
            console.warn(`[codex] approval callback threw, defaulting to deny: ${(err as Error).message}`);
          }
          // Send the optional user-supplied feedback as `reason` on denials so
          // codex can surface it back to the model. Unknown fields are ignored
          // by JSON-RPC peers, so this is safe even on codex builds that don't
          // read `reason`.
          if (result.decision === "deny" && result.feedback?.trim()) {
            respond(id, { decision: "deny", reason: result.feedback.trim() });
          } else {
            respond(id, { decision: result.decision });
          }
        })();
      }

      // ── Notification handling ──

      function handleNotification(method: string, rawParams: unknown): void {
        const params = (rawParams ?? {}) as Record<string, unknown>;

        if (process.env.ROTOM_CODEX_DEBUG) {
          console.log(`[codex DEBUG] notification method=${method} params=${JSON.stringify(params).slice(0, 600)}`);
        }

        // Legacy: codex/event
        if (method === "codex/event" || method.startsWith("codex/event/")) {
          notificationProtocol = "legacy";
          // 新版 codex 可能把 event_msg payload 直接放在 params 顶层(无 msg 包装),
          // 旧版放在 params.msg。两种都接受,避免 token_count / session_meta 这类
          // 事件被静默丢弃。
          const msg = (params.msg ?? params) as Record<string, unknown> | undefined;
          if (msg && typeof msg === "object" && "type" in msg) handleLegacyEvent(msg);
          return;
        }

        if (notificationProtocol === "legacy") return;
        if (
          notificationProtocol === "unknown" &&
          (method === "turn/started" ||
            method === "turn/completed" ||
            method === "thread/started" ||
            method.startsWith("item/"))
        ) {
          notificationProtocol = "raw";
        }

        if (notificationProtocol === "raw") handleRawNotification(method, params);
      }

      function handleLegacyEvent(msg: Record<string, unknown>): void {
        const type = msg.type as string;
        switch (type) {
          case "task_started":
            turnStarted = true;
            emitStatus(onOutput, "Working");
            return;
          case "agent_message": {
            const text = msg.message as string | undefined;
            if (text) {
              fullOutput += text;
              onOutput(text);
              // 不要在每个 chunk 都 emit "Working" — turn/started 已经发过了,
              // 这里再发反而会把 "Running" 状态打回 "Working",导致工具调用期间
              // pill 在两个状态之间闪烁。
            }
            return;
          }
          case "exec_command_begin": {
            const command = msg.command as string | undefined;
            onOutput(`[tool:exec]${prettyCommand(command ?? "")}[/tool:exec]\n`);
            emitStatus(onOutput, "Running");
            return;
          }
          case "exec_command_end": {
            const output = (msg.output as string | undefined) ?? "";
            const truncated = output.length > 500 ? `${output.slice(0, 500)}...` : output;
            if (truncated) onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
            // codex 不在工具完成时发 "Done" — tool 完成后模型进入 thinking,
            // 下一个 event (新 tool call / final_answer) 会自己覆盖 status。
            return;
          }
          case "patch_apply_begin":
            onOutput(`[tool:patch]apply[/tool:patch]\n`);
            emitStatus(onOutput, "Patching");
            return;
          case "patch_apply_end":
            // 同上:patch 完成不发 "Patched",让 status 保持上一个状态,等下一个
            // event 覆盖。
            return;
          case "task_complete":
            signalTurnDone(false);
            return;
          case "turn_aborted":
            signalTurnDone(true);
            return;
        }
      }

      function handleRawNotification(method: string, params: Record<string, unknown>): void {
        // Codex multiplexes child threads on the same stdio pipe; ignore
        // notifications that don't belong to the thread we started.
        const eventThreadId = params.threadId as string | undefined;
        if (eventThreadId && threadId && eventThreadId !== threadId) return;

        switch (method) {
          case "thread/started": {
            // thread/started 的 params.thread.modelProvider 是后端 provider 名
            // (e.g. "deepseek" / "openai"),用作 model 展示。codex 实际模型名
            // (e.g. "deepseek-v4-flash")只在某些 warning 文本里出现,不稳。
            const threadObj = (params.thread ?? {}) as Record<string, unknown>;
            const provider = threadObj.modelProvider as string | undefined;
            if (provider && !capturedModel) capturedModel = provider;
            // 落到下方 turn/started 之外的处理:thread/started 不算 turn 开始,
            // 不发 Working 状态。直接 return,不要触发 turn/started 的逻辑。
            return;
          }

          case "turn/started":
            turnStarted = true;
            emitStatus(onOutput, "Working");
            return;

          case "thread/tokenUsage/updated": {
            // codex v2 真正的 usage 通知。params.tokenUsage.total 是该 thread
            // 累计用量(input + 历史 turns),last 是本轮。我们存 total —— 一个
            // issue 可能多次 turn,最终值就是整个 issue 执行的总量。
            capturedUsage = parseCodexTokenUsage(params);
            return;
          }

          case "turn/completed": {
            const turn = (params.turn ?? {}) as Record<string, unknown>;
            const turnId = (turn.id as string | undefined) ?? "";
            const status = (turn.status as string | undefined) ?? "";
            const aborted =
              status === "cancelled" ||
              status === "canceled" ||
              status === "aborted" ||
              status === "interrupted";

            if (process.env.ROTOM_CODEX_DEBUG) {
              console.log(`[codex DEBUG] turn/completed params=${JSON.stringify(params).slice(0, 800)}`);
            }

            if (status === "failed") {
              const err = (turn.error as Record<string, unknown> | undefined) ?? {};
              setTurnError((err.message as string) || "codex turn failed");
              failed = true;
              if (!terminalEmitted) {
                emitStatus(onOutput, "Failed");
                terminalEmitted = true;
              }
            }

            if (turnId) {
              if (completedTurnIds.has(turnId)) return;
              completedTurnIds.add(turnId);
            }

            // 兜底:agentMessage final_answer 没拿到 phase / 没下发时,
            // 仍然需要一个终态 pill,否则 dashboard 一直停在 "Working"。
            // aborted 留给上一次的 non-terminal 状态(pill 视觉上停在"被打断
            // 那一刻"),不强行覆盖。
            if (!terminalEmitted && !aborted && status !== "failed") {
              emitStatus(onOutput, "Answered");
              terminalEmitted = true;
            }

            signalTurnDone(aborted);
            return;
          }

          case "error": {
            const willRetry = params.willRetry === true;
            const errMsg =
              ((params.error as Record<string, unknown> | undefined)?.message as string | undefined) ||
              (params.message as string | undefined) ||
              "";
            if (errMsg) {
              console.warn(`[codex] error notification: ${errMsg} (willRetry=${willRetry})`);
              if (!willRetry) {
                setTurnError(errMsg);
                failed = true;
              }
            }
            return;
          }

          case "thread/status/changed": {
            const statusType =
              ((params.status as Record<string, unknown> | undefined)?.type as string | undefined) ?? "";
            if (statusType === "idle" && turnStarted) signalTurnDone(false);
            return;
          }

          default:
            if (method.startsWith("item/")) handleItemNotification(method, params);
        }
      }

      function handleItemNotification(method: string, params: Record<string, unknown>): void {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) return;
        const itemType = item.type as string | undefined;
        const itemId = item.id as string | undefined;

        if (process.env.ROTOM_CODEX_DEBUG) {
          console.log(`[codex DEBUG] handleItemNotification method=${method} itemType=${itemType} itemId=${itemId} phase=${(item as Record<string, unknown>).phase ?? "(none)"} command=${String((item as Record<string, unknown>).command).slice(0, 60)}`);
        }

        // 用字段存在性判断 item 类型,而不是严格匹配 `type` 字符串 — 不同 codex
        // 版本对 enum variant 的序列化格式不一样(camelCase / snake_case / 别名),
        // 而且 codex 还在持续迭代(2026.5 的 v2 协议又引入了新 ThreadItem 变体),
        // 紧耦合 type 字符串会让这里脆弱。commandExecution 一定有 `command` 字段
        // (string 或 string[]),fileChange 一定有 `changes` / `patch` 字段。
        const looksLikeCommandExec = typeof (item as Record<string, unknown>).command !== "undefined";
        const looksLikeFileChange =
          (item as Record<string, unknown>).changes !== undefined ||
          (item as Record<string, unknown>).patch !== undefined;

        if (method === "item/started" && looksLikeCommandExec) {
          const rawCmd = item.command;
          const command = Array.isArray(rawCmd)
            ? rawCmd.map((p) => String(p)).join(" ")
            : ((rawCmd as string | undefined) ?? "");
          onOutput(`[tool:exec]${prettyCommand(command)}[/tool:exec]\n`);
          emitStatus(onOutput, "Running");
          if (process.env.ROTOM_CODEX_DEBUG) {
            console.log(`[codex DEBUG] emitted [tool:exec] + Running status for command=${command.slice(0, 60)}`);
          }
          return;
        }
        if (method === "item/completed" && looksLikeCommandExec) {
          const output =
            ((item as Record<string, unknown>).aggregatedOutput as string | undefined) ??
            ((item as Record<string, unknown>).output as string | undefined) ??
            "";
          const truncated = output.length > 500 ? `${output.slice(0, 500)}...` : output;
          if (truncated) onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
          // codex 不在 tool 完成时发 "Done" — 让 status 保持上一个状态,
          // 等下一个 event (新 tool / final_answer) 自己覆盖。
          // exitCode != 0 走 turn/completed 的 failed 分支,这里不再发 Failed,
          // 避免一个失败的 tool 就把整个 turn 标红。
          void item.exitCode;
          return;
        }
        if (method === "item/started" && looksLikeFileChange) {
          onOutput(`[tool:patch]apply[/tool:patch]\n`);
          emitStatus(onOutput, "Patching");
          return;
        }
        if (method === "item/completed" && looksLikeFileChange) {
          // 同上:patch 完成后不发 "Patched"。
          return;
        }
        // codex v2 协议下 agent message 是流式推送的,文本通过
        // `item/agentMessage/delta` 增量进来(delta 字段),完整消息在
        // `item/completed` 时带 phase 标识(Commentary / FinalAnswer)。
        // 不处理 delta 的话,dashboard 端 streaming 期间看不到 agent 文字,
        // pill 也永远卡在 "Working"(因为 turn/started 后没有新 status emit)。
        if (method === "item/agentMessage/delta") {
          const delta = (params.delta as string | undefined) ?? "";
          if (delta) {
            fullOutput += delta;
            onOutput(delta);
          }
          return;
        }

        if (method === "item/completed" && itemType === "agentMessage") {
          const text = (item.text as string | undefined) ?? "";
          if (text) {
            // 兜底:有些 codex 版本把完整文本塞在 item.completed 的 text 字段,
            // 而不用 delta 流推。这里只在 fullOutput 还没有这段文本时 push,
            // 避免和 delta 重复输出。
            if (!fullOutput.endsWith(text)) {
              fullOutput += text;
              onOutput(text);
            }
          }
          const phase = item.phase as string | undefined;
          // codex v2 协议 phase 取值是 PascalCase("FinalAnswer"/"Commentary"),
          // 见上方注释。大小写都接受,避免某个 minor 版本切回 snake_case 时
          // 又把 "Answered" 丢掉。
          if (phase && phase.toLowerCase() === "final_answer") {
            // "Answered" 是 terminal state,pill 会停在这里。
            if (!terminalEmitted) {
              emitStatus(onOutput, "Answered");
              terminalEmitted = true;
            }
            if (turnStarted) signalTurnDone(false);
          }
          return;
        }
        // itemId is reserved for future per-tool tracking; reference to silence lint.
        void itemId;
      }

      // ── Line router ──
      // (The transport above already routes server requests / notifications;
      //  responses are matched against the transport's pending map and resolve
      //  the corresponding `transport.request(...)` promises automatically.)

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) console.error(`[codex] stderr: ${text}`);
      });

      function finish(exitCode: number): void {
        if (settled) return;
        settled = true;

        // Reject any leftover pending requests so dangling promises don't keep the event loop alive.
        transport.rejectPending(new Error("codex process exited"));

        // 最后一道防线:某些 codex 边角场景下进程干净退出但 turn/completed
        // 路径没走到(或没匹配上),pill 会一直停在 "Working"。这里在 exit
        // code 0 且没下发过任何终态时,补发 "Answered"。fail / 非零退出
        // 路径交给 worker 通过 failed flag 标红,不在这里掺合。
        if (!terminalEmitted && exitCode === 0) {
          emitStatus(onOutput, "Answered");
          terminalEmitted = true;
        }

        const reportedSessionId = resolveSessionId(resumeSessionId, threadId, failed || exitCode !== 0);
        const finalCode = failed && exitCode === 0 ? 1 : exitCode;
        console.log(`[codex] Exited code=${exitCode}, output=${fullOutput.length} chars, session=${reportedSessionId}, poisoned=${sessionPoisoned}`);
        resolve({
          exitCode: finalCode,
          fullOutput,
          sessionId: sessionPoisoned ? undefined : (reportedSessionId || undefined),
          invalidateSession: sessionPoisoned || undefined,
          usage: capturedUsage,
          model: capturedModel,
        });
      }

      proc.on("close", (code) => finish(code ?? 1));
      proc.on("error", (err) => {
        console.error(`[codex] Spawn error: ${err.message}`);
        finish(1);
      });

      // ── Drive the protocol ──
      void (async () => {
        try {
          await request("initialize", {
            clientInfo: {
              name: "open-a2a-gateway",
              title: "Open A2A WORKSPACE",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true },
          });
          notify("initialized");

          threadId = await startOrResumeThread(request, resumeSessionId, workingDir, options?.slashCommand, options?.systemPrompt);

          await request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
          });

          const aborted = await turnDone;
          if (aborted) {
            failed = true;
            setTurnError("turn was aborted");
          } else if (turnError) {
            failed = true;
          }
        } catch (err) {
          failed = true;
          const msg = (err as Error).message;
          console.error(`[codex] lifecycle error: ${msg}`);
          setTurnError(msg);
          onOutput(`[error] ${msg}\n`);
        } finally {
          try { proc.stdin?.end(); } catch { /* noop */ }
        }
      })();
    });
  }

  /**
   * Read the tail of codex's session transcript from its local JSONL store.
   * Codex writes one file per session under
   *   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<sessionId>.jsonl`
   * with the sessionId as the trailing UUID before the `.jsonl` extension. We
   * walk the tree (find by suffix is cheaper than maintaining a date index)
   * and return the last N lines verbatim — the dashboard renders them as a
   * `<pre>` block.
   *
   * Tolerant of missing files (codex may prune its sessions directory) —
   * returns empty content + an explanatory `error` so the dashboard can
   * distinguish "file gone" from "session started but no output yet".
   */
  async readSessionContent(args: {
    sessionId: string;
    workingDir: string;
    tailLines?: number;
  }): Promise<{ format: "jsonl" | "text" | "raw"; content: string; error?: string }> {
    const file = findCodexRolloutFile(args.sessionId);
    if (!file) {
      return {
        format: "jsonl",
        content: "",
        error: "codex session 文件不存在（可能已被 codex CLI 清理）",
      };
    }
    const text = fs.readFileSync(file, "utf-8");
    return { format: "jsonl", content: sliceTail(text, args.tailLines ?? 200) };
  }
}

// ── Codex session-file lookup ───────────────────────────────────────────

/**
 * Walk ~/.codex/sessions/<YYYY>/<MM>/<DD>/ and find the rollout JSONL whose
 * filename ends with `-<sessionId>.jsonl`. Returns the absolute path or null
 * if no match. The 3-level date directory is what codex's `~/.codex/sessions`
 * layout uses in 2026.5+; on older builds the same files live flat under
 * `~/.codex/sessions/` so we walk two levels deep just in case.
 */
function findCodexRolloutFile(sessionId: string): string | null {
  const root = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(root)) return null;
  const suffix = `-${sessionId}.jsonl`;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(suffix)) {
        return full;
      }
    }
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function startOrResumeThread(
  request: (method: string, params?: unknown) => Promise<unknown>,
  resumeSessionId: string,
  cwd: string,
  slashCommand?: string,
  systemPrompt?: string,
): Promise<string> {
  // developerInstructions 通道同时承载"静态系统层"(rotom-cli/角色/群身份/cwd,
  // 来自 worker 的 systemPrompt)和 /plan 指令:两者都进 system 级提示。
  // 会话内静态层不变,thread/start 与 thread/resume 每轮幂等重传同一段。
  const planInstr = slashCommand === "/plan" ? buildPlanModeInstruction() : null;
  const developerInstructions = [systemPrompt, planInstr].filter(Boolean).join("\n") || null;
  if (resumeSessionId) {
    try {
      const res = (await request("thread/resume", {
        threadId: resumeSessionId,
        cwd,
        model: null,
        developerInstructions,
        // 同 thread/start:codex 默认 read-only 沙箱挡 127.0.0.1 回环,
        // rotom CLI 子命令全部 fetch failed。chat 路径默认走 resume
        // (~/.rotom/sessions.json 缓存),不补这行修复永远不生效。
        // 详见 docs/codex-sandbox-network-blocked.md。
        sandbox: "danger-full-access",
      })) as Record<string, unknown> | undefined;
      const id = extractThreadId(res);
      if (id) return id;
      console.warn(`[codex] thread/resume returned no thread id; falling back to thread/start (prior=${resumeSessionId})`);
    } catch (err) {
      console.warn(`[codex] thread/resume failed; falling back to thread/start: ${(err as Error).message}`);
    }
  }

  const res = (await request("thread/start", {
    model: null,
    modelProvider: null,
    profile: null,
    cwd,
    approvalPolicy: null,
    // codex CLI 默认 read-only 沙箱挡掉所有出站网络,包括 127.0.0.1 回环 ——
    // rotom CLI 任何子命令都打不到 master,统一报 "fetch failed"。worker 是
    // 受信进程、cwd 已隔离、命令经 dashboard 审批,沙箱那层防护是冗余的,
    // 这里拉满。详见 docs/codex-sandbox-network-blocked.md。
    sandbox: "danger-full-access",
    config: null,
    baseInstructions: null,
    developerInstructions,
    compactPrompt: null,
    includeApplyPatchTool: null,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  })) as Record<string, unknown> | undefined;

  const id = extractThreadId(res);
  if (!id) throw new Error("codex thread/start returned no thread id");
  return id;
}

export function extractThreadId(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const thread = r.thread as Record<string, unknown> | undefined;
  if (thread && typeof thread.id === "string") return thread.id;
  return "";
}

// resolveSessionId 已抽到 ../adapter-helpers.ts(codex 与 claude-code 共用)。

// Strip common shell wrappers so the dashboard renders the user-meaningful
// command instead of `/bin/bash -lc '<actual>'`.
export function prettyCommand(raw: string): string {
  let s = raw.trim();
  const wrapper = /^(?:\/bin\/)?(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]+)\1$/;
  const m = s.match(wrapper);
  if (m) s = m[2].trim();
  return s;
}

/**
 * 把 codex `thread/tokenUsage/updated` 通知的 params 映射成 TokenUsage。
 * codex v2 字段是 camelCase(inputTokens / outputTokens / cachedInputTokens),
 * 注意不是 cache_read_input_tokens。total 缺失或字段非 number 时对应位置留
 * undefined —— 与原内联实现完全等价。
 *
 * 抽成纯函数便于离线夹具测试(codex 各版本字段序列化在变,这里是静默
 * 出错的高危点)。
 */
export function parseCodexTokenUsage(params: Record<string, unknown>): TokenUsage {
  const tokenUsage = (params.tokenUsage ?? {}) as Record<string, unknown>;
  const total = (tokenUsage.total ?? {}) as Record<string, unknown>;
  return {
    inputTokens: typeof total.inputTokens === "number" ? total.inputTokens : undefined,
    outputTokens: typeof total.outputTokens === "number" ? total.outputTokens : undefined,
    cacheReadTokens: typeof total.cachedInputTokens === "number" ? total.cachedInputTokens : undefined,
    cacheCreationTokens: undefined,
    totalCostUsd: undefined,
  };
}

// ── Approval payload extraction ─────────────────────────────────────────
//
// Codex's app-server has shifted its exec/file approval params several times
// (top-level vs nested under `item`, command as string vs array). These
// helpers normalize the shapes we've seen into the worker-facing
// ApprovalRequestInput. When fields are missing we still build a usable
// summary so the human reviewer is never left with a blank card.

export function extractExecApprovalInput(params: Record<string, unknown>): ApprovalRequestInput {
  const source = (params.item as Record<string, unknown> | undefined) ?? params;
  const rawCmd = source.command;
  let command = "";
  if (typeof rawCmd === "string") {
    command = prettyCommand(rawCmd);
  } else if (Array.isArray(rawCmd)) {
    command = prettyCommand(rawCmd.map((p) => String(p)).join(" "));
  }
  const cwd = typeof source.cwd === "string" ? source.cwd : undefined;
  const reason = typeof source.reason === "string" ? source.reason : undefined;
  const summary = command
    ? `请求执行命令：${command.length > 200 ? command.slice(0, 200) + "…" : command}`
    : reason || "请求执行 shell 命令";
  return { kind: "exec", summary, command: command || undefined, cwd };
}

export function extractFileApprovalInput(params: Record<string, unknown>): ApprovalRequestInput {
  const source = (params.item as Record<string, unknown> | undefined) ?? params;
  const files: string[] = [];
  const collect = (changes: unknown): void => {
    if (!Array.isArray(changes)) return;
    for (const c of changes) {
      if (!c) continue;
      if (typeof c === "string") { files.push(c); continue; }
      if (typeof c === "object") {
        const rec = c as Record<string, unknown>;
        const p = (rec.path ?? rec.file ?? rec.targetPath) as unknown;
        if (typeof p === "string") files.push(p);
      }
    }
  };
  collect(source.changes);
  collect(source.files);
  collect((source.patch as Record<string, unknown> | undefined)?.changes);
  const summary = files.length
    ? `请求修改文件：${files.slice(0, 3).join("、")}${files.length > 3 ? `（共 ${files.length} 项）` : ""}`
    : "请求修改文件";
  return { kind: "file_change", summary, files: files.length ? files : undefined };
}
