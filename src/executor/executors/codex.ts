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

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ApprovalDecision, ApprovalRequestInput, CliExecutor, ExecuteOptions, ExecuteResult } from "../cli-executor.js";
import { buildPlanModeInstruction } from "../../shared/slash-commands.js";

// ── JSON-RPC types ──────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

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

      const needsCommunicationWrapper = options?.kind === "chat" || options?.kind === "collab";
      const wrappedPrompt = needsCommunicationWrapper
        ? [
            `关键规则：`,
            `- 如果是"给某人发消息私聊" → 执行 Bash: rotom send <对方名字> "<消息内容>"`,
            `- 如果是"在群里 @某人 发消息" → 执行 Bash: rotom group send <群ID> <对方名字> "@<对方名字> <消息内容>"`,
            `- ⚠️ 绝对不要使用 --as 参数，rotom 会自动使用你的身份`,
            `- 执行完 rotom 命令后，将其 stdout/stderr 的真实返回作为你的回复`,
            `- ⚠️ 禁止仅回复文字假装已执行，必须通过 Bash 实际调用 rotom`,
            ``,
            prompt,
          ].join("\n")
        : prompt;

      const args = ["app-server", "--listen", "stdio://"];
      const spawnEnv = { ...process.env, ...options?.env };
      console.log(`[codex] Spawning codex app-server (cwd: ${workingDir}, resume: ${resumeSessionId || "new"})`);

      const proc = spawn("codex", args, {
        cwd: workingDir,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const onAbort = () => {
        console.log(`[codex] Aborted, killing pid=${proc.pid}`);
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* noop */ } }, 3_000);
      };
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // ── Per-run state ──
      let nextId = 1;
      const pending = new Map<number, PendingRpc>();
      let fullOutput = "";
      let threadId = "";
      let settled = false;
      let failed = false;
      let turnError = "";
      let sessionPoisoned = false;
      let turnDoneResolve: ((aborted: boolean) => void) | null = null;
      let notificationProtocol: "unknown" | "legacy" | "raw" = "unknown";
      let turnStarted = false;
      const completedTurnIds = new Set<string>();

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

      // ── JSON-RPC primitives ──

      function send(msg: Record<string, unknown>): void {
        if (!proc.stdin || proc.stdin.destroyed) return;
        proc.stdin.write(JSON.stringify(msg) + "\n");
      }

      function request(method: string, params?: unknown): Promise<unknown> {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej, method });
          send({ jsonrpc: "2.0", id, method, params });
        });
      }

      function notify(method: string, params?: unknown): void {
        send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
      }

      function respond(id: unknown, result: unknown): void {
        send({ jsonrpc: "2.0", id, result });
      }

      function respondError(id: unknown, code: number, message: string): void {
        send({ jsonrpc: "2.0", id, error: { code, message } });
      }

      // ── Server → client requests (auto-approve) ──

      function handleServerRequest(raw: Record<string, unknown>): void {
        const id = raw.id;
        const method = raw.method as string;
        const params = (raw.params ?? {}) as Record<string, unknown>;
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
      function routeApproval(id: unknown, input: ApprovalRequestInput): void {
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

      // ── JSON-RPC responses ──

      function handleResponse(raw: Record<string, unknown>): void {
        const id = typeof raw.id === "number" ? raw.id : Number(raw.id);
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);

        if (raw.error) {
          const err = raw.error as { code?: number; message?: string };
          p.reject(new Error(`${p.method}: ${err.message ?? "rpc error"} (code=${err.code ?? "?"})`));
          return;
        }
        p.resolve(raw.result);
      }

      // ── Notification handling ──

      function handleNotification(raw: Record<string, unknown>): void {
        const method = raw.method as string;
        const params = (raw.params ?? {}) as Record<string, unknown>;

        // Legacy: codex/event
        if (method === "codex/event" || method.startsWith("codex/event/")) {
          notificationProtocol = "legacy";
          const msg = params.msg as Record<string, unknown> | undefined;
          if (msg) handleLegacyEvent(msg);
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
            return;
          case "agent_message": {
            const text = msg.message as string | undefined;
            if (text) {
              fullOutput += text;
              onOutput(text);
            }
            return;
          }
          case "exec_command_begin": {
            const command = msg.command as string | undefined;
            onOutput(`[tool:exec]${prettyCommand(command ?? "")}[/tool:exec]\n`);
            return;
          }
          case "exec_command_end": {
            const output = (msg.output as string | undefined) ?? "";
            const truncated = output.length > 500 ? `${output.slice(0, 500)}...` : output;
            if (truncated) onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
            return;
          }
          case "patch_apply_begin":
            onOutput(`[tool:patch]apply[/tool:patch]\n`);
            return;
          case "patch_apply_end":
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
          case "turn/started":
            turnStarted = true;
            return;

          case "turn/completed": {
            const turn = (params.turn ?? {}) as Record<string, unknown>;
            const turnId = (turn.id as string | undefined) ?? "";
            const status = (turn.status as string | undefined) ?? "";
            const aborted =
              status === "cancelled" ||
              status === "canceled" ||
              status === "aborted" ||
              status === "interrupted";

            if (status === "failed") {
              const err = (turn.error as Record<string, unknown> | undefined) ?? {};
              setTurnError((err.message as string) || "codex turn failed");
              failed = true;
            }

            if (turnId) {
              if (completedTurnIds.has(turnId)) return;
              completedTurnIds.add(turnId);
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

        if (method === "item/started" && itemType === "commandExecution") {
          const command = (item.command as string | undefined) ?? "";
          onOutput(`[tool:exec]${prettyCommand(command)}[/tool:exec]\n`);
          return;
        }
        if (method === "item/completed" && itemType === "commandExecution") {
          const output = (item.aggregatedOutput as string | undefined) ?? "";
          const truncated = output.length > 500 ? `${output.slice(0, 500)}...` : output;
          if (truncated) onOutput(`[tool-result:exec]${truncated}[/tool-result:exec]\n`);
          return;
        }
        if (method === "item/started" && itemType === "fileChange") {
          onOutput(`[tool:patch]apply[/tool:patch]\n`);
          return;
        }
        if (method === "item/completed" && itemType === "fileChange") {
          return;
        }
        if (method === "item/completed" && itemType === "agentMessage") {
          const text = (item.text as string | undefined) ?? "";
          if (text) {
            fullOutput += text;
            onOutput(text);
          }
          const phase = item.phase as string | undefined;
          if (phase === "final_answer" && turnStarted) signalTurnDone(false);
          return;
        }
        // itemId is reserved for future per-tool tracking; reference to silence lint.
        void itemId;
      }

      // ── Line router ──

      function handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(trimmed);
        } catch {
          return;
        }

        const hasId = "id" in raw && raw.id !== null && raw.id !== undefined;
        const hasMethod = typeof raw.method === "string";
        const hasResult = "result" in raw;
        const hasError = "error" in raw;

        if (hasId && (hasResult || hasError)) {
          handleResponse(raw);
          return;
        }
        if (hasId && hasMethod) {
          handleServerRequest(raw);
          return;
        }
        if (hasMethod) {
          handleNotification(raw);
        }
      }

      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", handleLine);

      proc.stderr!.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) console.error(`[codex] stderr: ${text}`);
      });

      function finish(exitCode: number): void {
        if (settled) return;
        settled = true;

        // Reject any leftover pending requests so dangling promises don't keep the event loop alive.
        for (const [, p] of pending) {
          p.reject(new Error("codex process exited"));
        }
        pending.clear();

        const reportedSessionId = resolveSessionId(resumeSessionId, threadId, failed || exitCode !== 0);
        const finalCode = failed && exitCode === 0 ? 1 : exitCode;
        console.log(`[codex] Exited code=${exitCode}, output=${fullOutput.length} chars, session=${reportedSessionId}, poisoned=${sessionPoisoned}`);
        resolve({
          exitCode: finalCode,
          fullOutput,
          sessionId: sessionPoisoned ? undefined : (reportedSessionId || undefined),
          invalidateSession: sessionPoisoned || undefined,
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
              title: "Open A2A Gateway",
              version: "0.1.0",
            },
            capabilities: { experimentalApi: true },
          });
          notify("initialized");

          threadId = await startOrResumeThread(request, resumeSessionId, workingDir, options?.slashCommand);

          await request("turn/start", {
            threadId,
            input: [{ type: "text", text: wrappedPrompt }],
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
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function startOrResumeThread(
  request: (method: string, params?: unknown) => Promise<unknown>,
  resumeSessionId: string,
  cwd: string,
  slashCommand?: string,
): Promise<string> {
  // /plan → codex 没有原生 plan 模式，靠 developerInstructions 注入开发者级
  // 系统提示，引导其"先方案后落盘"。注册表见 src/shared/slash-commands.ts。
  const developerInstructions = slashCommand === "/plan" ? buildPlanModeInstruction() : null;
  if (resumeSessionId) {
    try {
      const res = (await request("thread/resume", {
        threadId: resumeSessionId,
        cwd,
        model: null,
        developerInstructions,
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
    sandbox: null,
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

function extractThreadId(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const thread = r.thread as Record<string, unknown> | undefined;
  if (thread && typeof thread.id === "string") return thread.id;
  return "";
}

/**
 * Decide which session id to report. When resume was requested but codex emitted
 * a fresh, different thread id AND the run failed, the resume did not land —
 * return "" so the caller can retry fresh.
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

// Strip common shell wrappers so the dashboard renders the user-meaningful
// command instead of `/bin/bash -lc '<actual>'`.
function prettyCommand(raw: string): string {
  let s = raw.trim();
  const wrapper = /^(?:\/bin\/)?(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]+)\1$/;
  const m = s.match(wrapper);
  if (m) s = m[2].trim();
  return s;
}

// ── Approval payload extraction ─────────────────────────────────────────
//
// Codex's app-server has shifted its exec/file approval params several times
// (top-level vs nested under `item`, command as string vs array). These
// helpers normalize the shapes we've seen into the worker-facing
// ApprovalRequestInput. When fields are missing we still build a usable
// summary so the human reviewer is never left with a blank card.

function extractExecApprovalInput(params: Record<string, unknown>): ApprovalRequestInput {
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

function extractFileApprovalInput(params: Record<string, unknown>): ApprovalRequestInput {
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
