/**
 * ChatHandler — group chat replies for ExecutorWorker.
 *
 * handleChatReply serves @mention / DM turns; the activeTasks key is
 * `chat:${requestId}` so the WS router's `chat_cancelled` branch can find it.
 * Shares session/usage bookkeeping via the worker's SessionStore.
 */
import { composePrompt } from "../shared/prompt-composer.js";
import type { ExecutorWorker } from "./worker.js";
import { createLogger } from "../shared/logger.js";
import { repoNameFor } from "./repo-cache.js";

const log = createLogger("mesh-executor-worker-chat", { stream: "stderr" });

export class ChatHandler {
  /** 同群 chat 队列:groupId → 待处理消息队列。同群串行,保证 session 不丢。 */
  private groupChatQueues: Map<string, Array<{ requestId: string; content: string; fromName: string; conversation: any; cwdOverride?: string; repoUrl?: string }>> = new Map();
  private groupChatActive: Set<string> = new Set();

  constructor(private readonly worker: ExecutorWorker) {}

  async handleChatReply(requestId: string, content: string, fromName: string, conversation: any, cwdOverride?: string,
    repoUrl?: string,
  ): Promise<void> {
    const taskKey = `chat:${requestId}`;
    if (this.worker.activeTasks.has(taskKey)) return;

    const groupId: string = conversation?.id ?? conversation?.groupId ?? "";

    // 同群串行:若该群已有活跃 chat 任务,排队等当前任务结束(session 已存)再处理。
    // 避免新 chat 开新 session 丢失上下文(ask-bridge 复述到达时 A 的原始 turn 可能还没结束)。
    if (groupId && this.groupChatActive.has(groupId)) {
      const queue = this.groupChatQueues.get(groupId) ?? [];
      queue.push({ requestId, content, fromName, conversation, cwdOverride, repoUrl });
      this.groupChatQueues.set(groupId, queue);
      log.info(this.worker.tag, `Chat from ${fromName} queued for group ${groupId} (queue=${queue.length})`);
      return;
    }

    await this.runChatReply(requestId, content, fromName, conversation, cwdOverride, groupId, undefined, repoUrl);
  }

  private async runChatReply(
    requestId: string,
    content: string,
    fromName: string | null,
    conversation: any,
    cwdOverride: string | undefined,
    groupId: string,
    mergedSiblings?: Array<{ requestId: string; conversation: any }>,
    repoUrl?: string,
  ): Promise<void> {
    const taskKey = `chat:${requestId}`;
    // chat 不走 worktree:cwd 落产物根(~/.rotom/artifacts/<groupId>),master 推送的
    // override(Dashboard 群工作目录 / per-agent override)本机存在则优先,否则回落
    // 本地派生。repo 已在产物根的 __repos/<repoName>/ 子目录下,agent 只读访问即可
    // (prompt cwd 层会提示 repo 子目录位置)。issue 路径才起 worktree,互不影响。
    // 旧的 conversation.workingDir 仍忽略(展示元数据,与 spawn 无关)。
    const resolveChatCwd = async (): Promise<string> => this.worker.resolveIssueCwd(groupId || undefined, cwdOverride);

    if (this.worker.activeTasks.size >= this.worker.maxConcurrent) {
      this.worker.sendChatEnd(requestId, `[系统] 当前任务繁忙，请稍后再试`, conversation, await resolveChatCwd());
      return;
    }

    const controller = new AbortController();
    const task = { aborted: false, controller };
    this.worker.activeTasks.set(taskKey, task);
    if (groupId) this.groupChatActive.add(groupId);

    const body = content.replace(`@${this.worker.config.name}`, "").trim();

    if (!body) {
      this.worker.activeTasks.delete(taskKey);
      this.dequeueNextChat(groupId);
      this.worker.sendChatEnd(requestId, "你好，有什么可以帮你的？", conversation, await resolveChatCwd());
      return;
    }

    // Resolve session for this group
    const sessionId = groupId ? this.worker.sessions.get(this.worker.cliTool, groupId) : undefined;

    const cwd = await resolveChatCwd();

    // 拼 prompt:rotom-cli → agent-role → group-basic → cwd → task。
    // group 信息从 conversation 抽出(master 已 enrich 过 activeIssues / groupName)。
    // fromName 告诉 agent 这条消息是谁发的,避免 agent 不知道对话方身份。
    const composed = composePrompt({
      mode: "chat",
      agentName: this.worker.config.name,
      agentProfile: this.worker.agentProfile,
      group: conversation?.groupId
        ? {
            id: conversation.groupId,
            name: conversation.groupName || conversation.groupId,
            activeIssues: conversation.activeIssues ?? [],
            guidancePrompt: conversation.guidancePrompt ?? null,
            memoryCounts: conversation.memoryCounts,
            skillCount: conversation.skillCount,
          }
        : null,
      cwd,
      fromName: fromName || null,
      body,
      repoName: repoUrl ? repoNameFor(repoUrl) : undefined,
    });

    log.info(this.worker.tag, `Session lookup: cliTool=${this.worker.cliTool}, groupId=${groupId}, sessionId=${sessionId ?? "(none)"}, conversation=${JSON.stringify(conversation)}`);
    log.info(this.worker.tag, `Replying to ${fromName}: ${composed.final.slice(0, 60)}...`);

    // 合并 turn:把合并用的 composedPrompt 挂到 sibling 气泡上,让 dashboard
    // "查看 prompt"在每个被合并的 bubble 都能打开(否则 sibling 只有一条系统
    // 文案,hasPrompt=false,按钮不出现)。sibling 的 loading bubble 也由此关闭。
    if (mergedSiblings && mergedSiblings.length > 0) {
      for (const sib of mergedSiblings) {
        this.worker.sendChatEnd(sib.requestId, "[系统] 已合并到下一条回复", sib.conversation, undefined, composed);
      }
    }

    // 提到 try 块外:catch 路径下(子进程被 SIGTERM 后某些 executor 会 throw)
    // 仍要拿着已积累的 partial content 走 cancelled 终态,否则传空字符串给
    // master 会把前端已经看到的流式内容覆盖成空。
    let fullContent = "";
    try {
      // Chat replies (DM + @-mention in groups) intentionally do NOT pass
      // onApprovalRequest. Rationale:
      //   • Conversational tool calls should feel snappy — pausing for a
      //     human Accept/Deny breaks the chat UX.
      //   • Codex chat sessions are resumed by sessionId; a denied tool call
      //     leaves an "assistant tool_calls without matching tool message"
      //     hole in the conversation history, which makes the NEXT chat turn
      //     fail with `invalid_request_error: An assistant message with
      //     'tool_calls' must be followed by tool messages…`.
      // File writes here still need a backing in-progress issue (the prompt
      // tells the agent so — see composePrompt group-basic active_issues block).
      const execOptions: Parameters<typeof this.worker.executor.execute>[3] = {
        signal: controller.signal,
        env: this.worker.agentEnv(),
        kind: "chat",
        // 2-minute hard wall-clock cap on chat replies. Without this a
        // hanging openclaw subprocess can tie up the worker's
        // activeTasks slot until the user gives up and the daemon
        // restarts. Executors pass this through to `--timeout` AND set
        // a defensive SIGKILL after a small grace.
        timeoutMs: 120_000,
      };
      if (sessionId) execOptions.sessionId = sessionId;
      // cwd 按 groupId 派生
      const result = await this.worker.executor.execute(composed.final, cwd, (chunk) => {
        if (task.aborted) return;
        fullContent += chunk;
        this.worker.sendChatChunk(requestId, chunk);
      }, execOptions);

      // Drop the cached sessionId if the executor reports the conversation
      // history is poisoned (e.g. dangling tool_calls, or a terminal
      // provider error — see HermesCliExecutor's provider error sniffer).
      // Next chat turn will start fresh instead of trying to resume into
      // a broken transcript.
      //
      // 中断态不视为 poison —— codex 的 turn_aborted 走自己的清理路径,
      // session 可以正常续聊。只有 invalidateSession=true 且非用户主动中断
      // 时才丢弃 sessionId。
      if (groupId && result.invalidateSession && !task.aborted) {
        // 失效前抓住 sessionId,通知 master 在 DB 里打 invalidated_at 戳(保留历史)。
        const invalidatedSessionId = sessionId;
        this.worker.sessions.delete(this.worker.cliTool, groupId);
        log.warn(
          this.worker.tag,
          `Session invalidated: ${this.worker.cliTool}:${groupId}` +
          (result.failed ? " (provider error)" : " (poisoned history)"),
        );
        if (invalidatedSessionId) {
          this.worker.send({
            type: "session_invalidated",
            cliTool: this.worker.cliTool,
            groupId,
            sessionId: invalidatedSessionId,
          });
        }
        this.worker.sendSessionSnapshot();
      } else {
        // Persist sessionId for future messages in this group. Even when
        // result.sessionId is absent (some backends only return it on the
        // first turn), the existing session is still valid — record usage
        // so the Debug view can show this chat session's own token cost.
        if (groupId && result.sessionId) {
          this.worker.sessions.set(this.worker.cliTool, groupId, result.sessionId);
          log.info(this.worker.tag, `Session stored: ${this.worker.cliTool}:${groupId} → ${result.sessionId}`);
        }
        if (groupId && (result.usage || result.model)) {
          this.worker.sessions.recordUsage(this.worker.cliTool, groupId, result.usage, result.model);
          // Snapshot push is needed so master picks up the new usage/model.
          // Coalesce with the set() push above by always sending here when
          // we recorded anything.
          this.worker.sendSessionSnapshot();
        } else if (groupId && result.sessionId) {
          this.worker.sendSessionSnapshot();
        }
      }

      if (task.aborted) {
        // 用户中断:已积累的 partial content 落库(走 master 的 cancelled_at 路径),
        // bubble 切到「已中断」状态。不暴露 executor 返回的 aborted 错误文案 ——
        // 用户自己点的中断,不需要再看"turn was aborted" 之类的内部噪声。
        this.worker.sendChatEnd(requestId, fullContent, conversation, cwd, undefined, { cancelled: true });
        log.info(this.worker.tag, `Reply cancelled mid-stream to ${fromName} (kept ${fullContent.length} chars)`);
      } else {
        // Provider-error path: executor detected a terminal model failure
        // (e.g. hermes's "API call failed after N retries: …" reply, which
        // is not a legitimate assistant message). Surface it as a clean
        // [错误] notice instead of streaming the error string as the
        // agent's "answer". The dashboard's status pill is already on
        // "Failed" from the executor's [status:Failed] emit.
        if (result.failed) {
          const reason = result.errorMessage || "unknown provider error";
          this.worker.sendChatEnd(
            requestId,
            `[错误] 模型调用失败：${reason}\n（已清空会话上下文,下一条消息将重新开始）`,
            conversation,
            cwd,
            composed,
          );
          log.error(this.worker.tag, `Provider error surfaced to ${fromName}: ${reason}`);
        } else {
          this.worker.sendChatEnd(requestId, fullContent, conversation, cwd, composed);
          log.info(this.worker.tag, `Reply sent to ${fromName} (${fullContent.length} chars)`);
        }
      }
    } catch (err: any) {
      if (task.aborted) {
        // 子进程被 SIGTERM/SIGKILL 时 executor 可能 throw(SIGNAL error),
        // 这是用户主动取消的预期结果,走 cancelled 终态而不是 error。
        this.worker.sendChatEnd(requestId, fullContent, conversation, cwd, undefined, { cancelled: true });
        log.info(this.worker.tag, `Reply cancelled (executor threw on abort) to ${fromName} (kept ${fullContent.length} chars)`);
      } else {
        this.worker.sendChatEnd(requestId, `[错误] ${err.message}`, conversation, cwd, composed);
        log.error(this.worker.tag, "Reply error:", err.message);
      }
    } finally {
      this.worker.activeTasks.delete(taskKey);
      this.dequeueNextChat(groupId);
    }
  }

  /** 当前群 chat 任务结束,从队列取下一条处理。session 已存,新任务能复用。
   *  积压合并:队列里有 ≥2 条待处理时,取最多 MAX_MERGE=3 条合并成一次 turn
   *  (首条 requestId 作主回复流,其余发系统文案 bubble 关闭 loading),省 LLM 调用。
   */
  private dequeueNextChat(groupId: string): void {
    if (!groupId) return;
    this.groupChatActive.delete(groupId);
    const queue = this.groupChatQueues.get(groupId);
    if (!queue || queue.length === 0) {
      this.groupChatQueues.delete(groupId);
      return;
    }
    const MAX_MERGE = 3;
    const batch = queue.splice(0, Math.min(MAX_MERGE, queue.length));
    if (queue.length === 0) this.groupChatQueues.delete(groupId);

    if (batch.length === 1) {
      const n = batch[0];
      log.info(this.worker.tag, `Dequeue chat from ${n.fromName} for group ${groupId} (remaining=${queue.length})`);
      this.runChatReply(n.requestId, n.content, n.fromName, n.conversation, n.cwdOverride, groupId, undefined, n.repoUrl).catch((err) => {
        log.error(this.worker.tag, "Dequeued chat error:", err.message);
      });
      return;
    }

    // 合并:首条作主 requestId 流式回复,其余 sibling 在 runChatReply compose 完后
    // 用同一份 composedPrompt 关闭 loading(让 dashboard 每个 sibling 都能查看 prompt)。
    const primary = batch[0];
    const mergedNames = batch.map((b) => b.fromName).join(", ");
    const siblings = batch.slice(1).map((b) => ({ requestId: b.requestId, conversation: b.conversation }));
    // 合并 body:每条标 [from=X] 让 agent 区分发送者;fromName 传 null 避免 composePrompt
    // 再加单 sender 头(多 sender 已在 body 内标注)。
    const mentionTag = `@${this.worker.config.name}`;
    const mergedBody = batch
      .map((b) => `[from=${b.fromName}]\n${b.content.replace(mentionTag, "").trim()}`)
      .join("\n\n---\n\n");
    log.info(this.worker.tag, `Dequeue merged chat for group ${groupId} (merged=${batch.length}, from=[${mergedNames}], remaining=${queue.length})`);
    this.runChatReply(primary.requestId, mergedBody, null, primary.conversation, primary.cwdOverride, groupId, siblings, primary.repoUrl).catch((err) => {
      log.error(this.worker.tag, "Dequeued merged chat error:", err.message);
    });
  }
}
