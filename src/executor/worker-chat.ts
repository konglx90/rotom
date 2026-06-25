/**
 * ChatHandler — group chat replies and collaboration kickoff for ExecutorWorker.
 *
 * handleChatReply serves @mention / DM turns; the activeTasks key is
 * `chat:${requestId}` so the WS router's `chat_cancelled` branch can find it.
 * handleCollaborationStarted is the first-speaker kickoff for a collaboration
 * round; key is `collab-${issueId}`. Both share session/usage bookkeeping via
 * the worker's SessionStore.
 */
import { composePrompt } from "../shared/prompt-composer.js";
import type { ExecutorWorker } from "./worker.js";

export class ChatHandler {
  constructor(private readonly worker: ExecutorWorker) {}

  async handleChatReply(requestId: string, content: string, fromName: string, conversation: any): Promise<void> {
    const taskKey = `chat:${requestId}`;
    if (this.worker.activeTasks.has(taskKey)) return;

    const groupId: string = conversation?.id ?? conversation?.groupId ?? "";
    // cwd 走本机派生:<workingDirMap[groupId]> 或 <base>/<groupId>。
    // 故意忽略 conversation.workingDir —— 那是 master DB 里存的绝对路径,
    // 多机部署下推到非 master executor 时目录不存在,会导致 spawn 失败。
    // 详见 resolveIssueCwd 上方"跨机器部署安全"注释。
    const resolveChatCwd = (): string => this.worker.resolveIssueCwd(groupId || undefined);

    if (this.worker.activeTasks.size >= this.worker.maxConcurrent) {
      this.worker.sendChatEnd(requestId, `[系统] 当前任务繁忙，请稍后再试`, conversation, resolveChatCwd());
      return;
    }

    const controller = new AbortController();
    const task = { aborted: false, controller };
    this.worker.activeTasks.set(taskKey, task);

    const body = content.replace(`@${this.worker.config.name}`, "").trim();

    if (!body) {
      this.worker.activeTasks.delete(taskKey);
      this.worker.sendChatEnd(requestId, "你好，有什么可以帮你的？", conversation, resolveChatCwd());
      return;
    }

    // Resolve session for this group
    const sessionId = groupId ? this.worker.sessions.get(this.worker.cliTool, groupId) : undefined;

    const cwd = resolveChatCwd();

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
          }
        : null,
      cwd,
      fromName: fromName || null,
      body,
    });

    console.log(`${this.worker.tag} Session lookup: cliTool=${this.worker.cliTool}, groupId=${groupId}, sessionId=${sessionId ?? "(none)"}, conversation=${JSON.stringify(conversation)}`);
    console.log(`${this.worker.tag} Replying to ${fromName}: ${composed.final.slice(0, 60)}...`);

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
        this.worker.sessions.delete(this.worker.cliTool, groupId);
        console.warn(
          `${this.worker.tag} Session invalidated: ${this.worker.cliTool}:${groupId}` +
          (result.failed ? " (provider error)" : " (poisoned history)"),
        );
        this.worker.sendSessionSnapshot();
      } else {
        // Persist sessionId for future messages in this group. Even when
        // result.sessionId is absent (some backends only return it on the
        // first turn), the existing session is still valid — record usage
        // so the Debug view can show this chat session's own token cost.
        if (groupId && result.sessionId) {
          this.worker.sessions.set(this.worker.cliTool, groupId, result.sessionId);
          console.log(`${this.worker.tag} Session stored: ${this.worker.cliTool}:${groupId} → ${result.sessionId}`);
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
        console.log(`${this.worker.tag} Reply cancelled mid-stream to ${fromName} (kept ${fullContent.length} chars)`);
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
          console.error(`${this.worker.tag} Provider error surfaced to ${fromName}: ${reason}`);
        } else {
          this.worker.sendChatEnd(requestId, fullContent, conversation, cwd, composed);
          console.log(`${this.worker.tag} Reply sent to ${fromName} (${fullContent.length} chars)`);
        }
      }
    } catch (err: any) {
      if (task.aborted) {
        // 子进程被 SIGTERM/SIGKILL 时 executor 可能 throw(SIGNAL error),
        // 这是用户主动取消的预期结果,走 cancelled 终态而不是 error。
        this.worker.sendChatEnd(requestId, fullContent, conversation, cwd, undefined, { cancelled: true });
        console.log(`${this.worker.tag} Reply cancelled (executor threw on abort) to ${fromName} (kept ${fullContent.length} chars)`);
      } else {
        this.worker.sendChatEnd(requestId, `[错误] ${err.message}`, conversation, cwd, composed);
        console.error(`${this.worker.tag} Reply error:`, err.message);
      }
    } finally {
      this.worker.activeTasks.delete(taskKey);
    }
  }

  /** Handle collaboration_started notification — generate initial contribution. */
  async handleCollaborationStarted(
    issueId: string, title: string, collaborationGoal: string,
    participants: string[], round: number, maxRounds: number, groupId: string,
  ): Promise<void> {
    const taskKey = `collab-${issueId}`;
    if (this.worker.activeTasks.has(taskKey)) return;

    const controller = new AbortController();
    const task = { aborted: false, controller };
    this.worker.activeTasks.set(taskKey, task);

    const sessionId = groupId ? this.worker.sessions.get(this.worker.cliTool, groupId) : undefined;

    try {
      const body = [
        `你被指定为协作任务「${title}」的首位发言人，由你来推进协作并决策走向。`,
        `协作目标：${collaborationGoal}`,
        `参与者：${participants.join("、")}（你在第一位，其余成员等待你 @ 邀请发言）`,
        `当前轮次：第 ${round} 轮 / 共 ${maxRounds} 轮`,
        `IssueId：${issueId}`,
        ``,
        `行动指引（按这个顺序考虑）：`,
        `1) 先在群里发表你的初步观点 / 方案 / 问题分析`,
        `2) 决定下一步：`,
        `   - 若需要其他成员补充：用 rotom group send 在 message 开头 @目标名字，等待对方回复后再继续`,
        `   - 若已经达成目标、或继续协作收益不大：调用 rotom collab conclude ${issueId} --summary "..." 主动结束`,
        `3) 不要尝试一次 @ 多个人；每轮只 @ 一位下一个发言人`,
        `4) 不要替别人代答；等他们的真实回复`,
      ].join("\n");

      // cwd 按 groupId 派生
      const cwd = this.worker.resolveIssueCwd(groupId);
      // collab 模式也没有 activeIssues(group-basic 层折叠),只拼 rotom-cli +
      // agent-role + cwd + task 四层。
      const composed = composePrompt({
        mode: "collab",
        agentName: this.worker.config.name,
        agentProfile: this.worker.agentProfile,
        group: null,
        cwd,
        body,
      });
      const collabExecOptions: Parameters<typeof this.worker.executor.execute>[3] = { signal: controller.signal, env: this.worker.agentEnv(), kind: "collab" };
      if (sessionId) collabExecOptions.sessionId = sessionId;
      const result = await this.worker.executor.execute(composed.final, cwd, (_chunk) => {
        if (task.aborted) return;
        // Stream chunks — the agent's tools handle communication
      }, collabExecOptions);

      if (groupId && result.invalidateSession) {
        this.worker.sessions.delete(this.worker.cliTool, groupId);
        this.worker.sendSessionSnapshot();
      } else {
        if (groupId && result.sessionId) {
          this.worker.sessions.set(this.worker.cliTool, groupId, result.sessionId);
        }
        if (groupId && (result.usage || result.model)) {
          this.worker.sessions.recordUsage(this.worker.cliTool, groupId, result.usage, result.model);
          this.worker.sendSessionSnapshot();
        } else if (groupId && result.sessionId) {
          this.worker.sendSessionSnapshot();
        }
      }

      if (task.aborted) return;

      // The agent's tools (rotom group send) handle communication.
      // The collaboration tracking in Master will pick up the group messages automatically.
      console.log(`${this.worker.tag} Collaboration contribution ready for "${title}" (${result.fullOutput.length} chars)`);
    } catch (err: any) {
      if (!task.aborted) {
        console.error(`${this.worker.tag} Collaboration error:`, err.message);
      }
    } finally {
      this.worker.activeTasks.delete(taskKey);
    }
  }
}
