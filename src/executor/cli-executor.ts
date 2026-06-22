/**
 * Code Agent — CLI Executor interface
 *
 * Pluggable interface for spawning CLI tools (Claude Code, Codex, etc.)
 * to execute issue tasks. Each executor wraps a specific CLI tool and
 * streams output back via the onOutput callback.
 */

import type { TokenUsage } from "../shared/protocol.js";

// Re-export TokenUsage from the shared protocol so executor implementations
// can keep importing it from "../cli-executor.js". The canonical definition
// lives in protocol.ts so master-side code can use it without depending on
// the executor module.
export type { TokenUsage } from "../shared/protocol.js";

/**
 * What a CLI executor reports up to the worker when the underlying tool wants
 * permission for a side-effecting action. The worker is responsible for
 * minting an `approvalId` and routing the question to a human via the
 * Master/Dashboard pipeline; the executor only describes the action.
 */
export interface FileEditDiff {
  tool: string;
  hunks: Array<{ old_string: string; new_string: string }>;
  new_content?: string;
  truncated?: boolean;
}

/** A single AskUserQuestion item (Claude Code AskUserQuestion tool input shape). */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export interface ApprovalRequestInput {
  kind: "exec" | "file_change" | "plan" | "ask";
  /** One-line description for surfacing in lists / notifications. */
  summary: string;
  /** kind=exec: full shell command codex would run. */
  command?: string;
  /** kind=exec: working directory the command would run in. */
  cwd?: string;
  /** kind=file_change: paths the tool wants to create / modify / delete. */
  files?: string[];
  /** kind=plan: markdown plan body the agent wants the user to approve. */
  plan?: string;
  /** kind=file_change: diff details showing what will change. */
  diff?: FileEditDiff;
  /** kind=ask: structured questions for the user to answer. */
  questions?: AskUserQuestionItem[];
}

/**
 * Result of a human approval gate. `feedback` is only meaningful on `deny` —
 * it carries the user's free-text explanation so the underlying CLI tool can
 * receive a meaningful denial reason (claude → permissionDecisionReason,
 * codex → JSON-RPC `reason`) instead of a generic "denied" string.
 */
export type ApprovalDecision =
  | { decision: "accept" }
  | { decision: "deny"; feedback?: string };

export interface ExecuteOptions {
  /** Resume a previous conversation by sessionId (empty = new session). */
  sessionId?: string;
  /** Abort signal — when triggered, the spawned CLI process should be killed. */
  signal?: AbortSignal;
  /**
   * Hard wall-clock timeout for the spawned CLI process, in milliseconds.
   * Executors should pass this through to the underlying CLI when supported
   * (e.g. `openclaw agent --timeout N`) AND set a defensive timer that
   * SIGKILLs the process after `timeoutMs + graceMs` if the CLI ignores it.
   * Without this a single hanging subprocess can stall the worker's
   * maxConcurrent slot indefinitely.
   */
  timeoutMs?: number;
  /** Extra environment variables to pass to the spawned CLI process. */
  env?: Record<string, string>;
  /**
   * Optional approval gate. When provided, the executor MUST route any
   * permission requests (shell exec, file change, ...) through this callback
   * instead of auto-approving. The Promise resolves with the user decision;
   * the executor should respond to its underlying CLI accordingly.
   *
   * If the callback is omitted, the executor falls back to auto-accept so
   * non-interactive contexts (tests, daemons) continue to work.
   */
  onApprovalRequest?: (req: ApprovalRequestInput) => Promise<ApprovalDecision>;
  /**
   * Task kind. Determines whether the executor wraps the prompt with the
   * rotom-a2a-communicate skill prefix. Only "chat" and "collab" tasks need
   * to send messages via rotom; "issue" tasks (the default) execute the
   * prompt directly without any communication wrapper — otherwise the model
   * is misled into treating the issue body as a "send a message" request.
   */
  kind?: "issue" | "chat" | "collab";
  /**
   * Slash command 声明（如 "/plan"）。由 master 端解析 issue title 后下发。
   * 各 executor 据此切换底层 CLI 的执行模式：
   *   claude → --permission-mode plan
   *   codex  → thread/start 注入 developerInstructions
   * 注册表见 src/shared/slash-commands.ts。
   */
  slashCommand?: string;
  /**
   * 工具调用审批策略。worker 端按 issue.approval_policy 取值：
   *   'r_allow'  (默认) → worker 仍会传 onApprovalRequest，写类工具需人工审批
   *   'rw_allow'         → worker 不传 onApprovalRequest；claude 走纯 bypass，
   *                        codex 内部 auto-accept exec/file_change
   * executor 主要消费的是 onApprovalRequest 是否传入；本字段透传到 executor
   * 内部仅用于日志/将来可能扩展更细的 hook 行为。
   */
  approvalPolicy?: "r_allow" | "rw_allow";
}

export interface ExecuteResult {
  exitCode: number;
  fullOutput: string;
  /** Session ID for future resumption (empty if not supported). */
  sessionId?: string;
  /** Token usage captured from the backend's final session summary. */
  usage?: TokenUsage;
  /** Model name the backend actually used (e.g. `gpt-5`, `claude-sonnet-4-6`). */
  model?: string;
  /**
   * When true, the caller should drop any cached sessionId for this
   * conversation (e.g. delete its sessionStore entry). Set by executors
   * when they detect the underlying conversation history has become
   * unrecoverable — e.g. codex chat sessions that ended with an
   * `assistant tool_calls` message that never got a matching tool reply,
   * which makes every subsequent resume fail with `invalid_request_error`.
   */
  invalidateSession?: boolean;
  /**
   * Set when the executor detected a terminal provider/model failure that
   * is not a legitimate assistant reply — e.g. hermes's
   * "API call failed after N retries: ..." that acp_adapter/server.py
   * sends as an `agent_message_chunk` when retries are exhausted.
   *
   * Callers (worker.handleChatReply) should:
   *   • surface `errorMessage` to the dashboard as a system error
   *     instead of treating `fullOutput` as a successful chat reply,
   *   • drop any cached sessionId (the next turn should start fresh),
   *   • not stream the error string as assistant prose.
   */
  failed?: boolean;
  /** Human-readable reason for `failed`. Shown to the user verbatim. */
  errorMessage?: string;
}

export interface CliExecutor {
  /** Spawn the CLI tool with the given prompt in the given directory. */
  execute(
    prompt: string,
    workingDir: string,
    onOutput: (chunk: string) => void,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult>;
  /**
   * Read the tail of a session's transcript from the CLI tool's local storage.
   * Optional — backends without direct file access (codex / hermes / openclaw)
   * can omit this; the worker will surface a "not introspectable" response
   * to the dashboard instead of an error.
   *
   * Implementations should be tolerant of missing files (the session may have
   * been pruned by the CLI tool itself) — return empty content + an `error`
   * string so the dashboard can distinguish "file gone" from "session started
   * but no output yet". Throwing would surface as a 500 to the dashboard.
   */
  readSessionContent?(args: {
    sessionId: string;
    /** Cwd the CLI was actually spawned in for this group. */
    workingDir: string;
    /** Trailing lines to read. Default 200. */
    tailLines?: number;
  }): Promise<{ format: "jsonl" | "text" | "raw"; content: string; error?: string }>;
}
