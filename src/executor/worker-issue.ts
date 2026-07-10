/**
 * IssueHandler — issue execution lifecycle for ExecutorWorker.
 *
 * Owns the per-issue CLI execution loop, including abort/cancel/interrupt
 * semantics, the append-queue (pendingAppends), and the approval gate that
 * gates writes under r_allow policy. State maps (activeTasks,
 * pendingApprovals, pendingAppends) live on the worker so the WS router and
 * other handlers can see them.
 */
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequestInput, ExecuteResult } from "./cli-executor.js";
import { composePrompt, type ComposedPrompt } from "../shared/prompt-composer.js";
import { isReadonlyCommand } from "../shared/readonly-allowlist.js";
import { parseSlashCommand } from "../shared/slash-commands.js";
import type { ExecutorWorker } from "./worker.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-executor-worker-issue", { stream: "stderr" });

export interface IssueRepoCtx {
  issueId?: string;
  groupId?: string;
  repoUrl?: string;
  repoBranch?: string;
  extraRepos?: { id: string; url: string; branch?: string; mountPath: string }[];
  worktreeMode?: string;
}

export class IssueHandler {
  constructor(private readonly worker: ExecutorWorker) {}

  async executeIssue(issueId: string, title: string, description: string, cwd: string, slashCommand?: string, approvalPolicy?: "r_allow" | "rw_allow", repoCtx?: IssueRepoCtx): Promise<void> {
    // title 现在是 description 的截断,不再拼进 body——否则会重复用户输入。
    // body 直接用 description,仅在 /plan 模式剥掉前缀。cleanTitle 仅用于 header 展示。
    let cleanTitle = title;
    if (slashCommand) {
      const parsed = parseSlashCommand(title);
      if (parsed?.known && parsed.command === slashCommand) {
        cleanTitle = parsed.stripped || title;
      }
    }
    let body = (description || "").trim();
    if (slashCommand && body) {
      const parsed = parseSlashCommand(body);
      if (parsed?.known && parsed.command === slashCommand) {
        body = parsed.stripped || body;
      }
    }
    // 注入 issue 执行上下文,让 agent 知道自己已在 issue 中,避免重复建 issue。
    const issueHeader =
      `[当前群活跃 issue]\n` +
      `- #${issueId.slice(0, 8)}  in_progress  "${cleanTitle}" by ${this.worker.config.name}\n` +
      `提示：你正在执行此 issue，工作目录 **可写**，直接按任务描述动手即可。` +
      `**不要为此任务再创建新 issue。**\n`;
    const bodyWithContext = `${issueHeader}\n${body}`;
    // issue 模式没有 conversation(group_basic 层无法渲染,因为 worker 这边没有
    // activeIssues 数据);只拼 rotom-cli + agent-role + cwd + task 四层。
    const composed = composePrompt({
      mode: "issue",
      agentName: this.worker.config.name,
      agentProfile: this.worker.agentProfile,
      group: null,
      cwd,
      body: bodyWithContext,
      approvalPolicy,
    });
    this.runIssueExecution(issueId, composed.userMessage, cwd, undefined, slashCommand, approvalPolicy, composed, repoCtx);
  }

  /**
   * Core issue execution loop — shared by first-run (executeIssue) and
   * continuation (handleIssueContinue). When resumeSessionId is provided the
   * CLI gets --resume / thread/resume so the conversation picks up where it
   * left off.
   *
   * repoCtx 用于 issue 完成后可选的 worktree 清理(当前实现不在终态自动清理,
   * 留给 issue delete/cancel 路径触发;此处仅保存上下文备用)。
   */
  async runIssueExecution(issueId: string, prompt: string, cwd: string, resumeSessionId?: string, slashCommand?: string, approvalPolicy?: "r_allow" | "rw_allow", composedPrompt?: ComposedPrompt, repoCtx?: IssueRepoCtx): Promise<void> {
    if (this.worker.activeTasks.size >= this.worker.maxConcurrent) {
      log.info(this.worker.tag, `At capacity (${this.worker.maxConcurrent}), skip ${issueId}`);
      return;
    }
    if (this.worker.activeTasks.has(issueId)) return;

    const controller = new AbortController();
    const task: { aborted: boolean; interrupted?: boolean; controller: AbortController } = { aborted: false, controller };
    this.worker.activeTasks.set(issueId, task);

    const cliName = this.worker.config.cliTool || "cli";
    this.worker.sendUpdate(issueId, "in_progress", `${resumeSessionId ? "Resuming" : "Starting"} with ${cliName}...`, undefined, cwd);

    // 本轮结束后用于喂给 append 续跑的 sessionId — 优先用本轮新产出的,
    // fall back 到入参 resumeSessionId(本轮没拿到新 session 时,比如 codex 早退)。
    let lastSessionId: string | undefined = resumeSessionId;

    // 写策略跟随 issue.approval_policy 入参;master 端 normalizeApprovalPolicy
    // 已把 undefined / 脏值收敛成有效值,,这里再兜一次底:undefined 当 rw_allow
    // 走(写需审批),符合 protocol 默认。PreToolUse hook 始终挂载:避免 claude
    // 自己的权限提示因 stdin 关闭而卡死。r_allow 下 hook 走 issue_approval_request
    // 挂起等用户决策,rw_allow 下本地立即 accept 不阻塞 CLI。
    const effectivePolicy: "r_allow" | "rw_allow" = approvalPolicy ?? "rw_allow";
    const onApprovalRequest = (req: ApprovalRequestInput) => {
      const approvalId = randomUUID();
      if (effectivePolicy === "rw_allow") {
        // rw_allow:立即放行,本地 decision=accept。不发 issue_approval_request
        // 给 master —— 否则 Dashboard 会渲染成"待确认"卡片,误导用户以为
        // agent 被阻塞,实际底层 claude 已经继续跑。审计/可见性可从 master
        // 日志 + claude session jsonl 拉(都是 fullOutput 的一部分)。
        return Promise.resolve({ decision: "accept" } satisfies ApprovalDecision);
      }
      // r_allow + 只读 Bash:命中内置白名单直接 accept,不弹 dashboard 卡片。
      // 安全契约(fail-closed):复合命令(管道/重定向/&&/;/`/$()/\\)及前导 env
      // 赋值一律不命中,详见 src/shared/readonly-allowlist.ts。file_change/plan/
      // ask 不查白名单,继续走 dashboard。
      if (req.kind === "exec" && isReadonlyCommand(req.command)) {
        log.info(this.worker.tag, `auto-approve readonly exec: ${req.command}`);
        return Promise.resolve({ decision: "accept" } satisfies ApprovalDecision);
      }
      // r_allow:Dashboard 侧能看到请求记录,挂起等待用户 Accept/Deny
      this.worker.send({
        type: "issue_approval_request",
        issueId,
        approvalId,
        kind: req.kind,
        summary: req.summary,
        command: req.command,
        cwd: req.cwd,
        files: req.files,
        plan: req.plan,
        diff: req.diff,
        questions: req.questions,
      });
      return new Promise<ApprovalDecision>((resolve) => {
        this.worker.pendingApprovals.set(approvalId, { issueId, resolve });
      });
    };

    // result 提到 try 外声明,让 finally 能访问 result.usage 给 flushIssueUsage
    // 做终态覆盖。execute 抛错时 result 为 undefined,flush 用累积值兜底。
    let result: ExecuteResult | undefined;
    try {
      result = await this.worker.executor.execute(prompt, cwd, (chunk) => {
        if (task.aborted) return;
        this.worker.sendUpdate(issueId, "in_progress", chunk, undefined, cwd);
      }, {
        signal: controller.signal,
        env: this.worker.agentEnv(),
        kind: "issue",
        systemPrompt: composedPrompt?.systemPrompt,
        sessionId: resumeSessionId,
        slashCommand,
        approvalPolicy: effectivePolicy,
        onApprovalRequest,
        onTodos: (todos) => {
          if (task.aborted) return;
          // 单独走 issue_todos_update WS 消息,不混进 issue_update 的 progress
          // 事件流——后者会产生 [tool:exec] 等气泡,todos 不该走那条路。
          this.worker.send({ type: "issue_todos_update", issueId, todos });
        },
        onUsage: (increment) => {
          if (task.aborted) return;
          // executor 给单轮增量,worker 内部 sum 成累积值并 1s 节流推送。
          // 不调 onUsage 的 backend(codex/hermes)→ 本回调不被触发,
          // IssueStatusBar 自然降级到终态 issue.usage。
          this.worker.reportIssueUsage(issueId, increment);
        },
      });

      // 不管后续走 abort / completed / failed 哪条分支,先把本轮 sessionId
      // 抓回来 —— finally 的队列续跑要用它做 --resume,丢了就起新会话丢上下文。
      // 之前的 bug:interrupt 走 `if (task.aborted) return` 早返回,这行被跳过,
      // 队列续跑 lastSessionId=undefined → claude 起新会话,前一轮工作全丢。
      if (result?.sessionId) lastSessionId = result.sessionId;

      if (task.aborted) {
        // 中断/取消事件已由 /interrupt 或 /cancel API 在落 issue_event 的同时
        // 推 WS 给 worker,worker 不再二次 sendUpdate —— 否则 master 会再落一条
        // progress 事件,把 "[interrupted] 当前步骤已中断..." 这种系统话塞进
        // agent 的对话气泡(被 groupEvents 当成 mergeable progress 合并)。
        // sessionId 已在上面抓回,finally 块会用它做 --resume 续跑队列。
        return;
      }

      const artifacts = this.extractArtifacts(result.fullOutput);

      // Persist sessionId + cliTool so the master can feed them back for
      // continuation (POST /issues/:id/continue → issue_continue WS).
      const sessionMeta: Record<string, unknown> = { artifacts };
      if (result.sessionId) {
        sessionMeta.sessionId = result.sessionId;
      } else if (resumeSessionId) {
        // Resume was requested but executor returned no session (e.g. claude
        // "No conversation found"). Clear the stale session_id in DB so the
        // next continuation starts fresh instead of retrying the dead session.
        sessionMeta.sessionId = null;
      }
      sessionMeta.cliTool = this.worker.cliTool;
      if (result.usage) sessionMeta.usage = result.usage;
      if (result.model) sessionMeta.model = result.model;

      if (result.exitCode === 0) {
        this.worker.sendUpdate(issueId, "completed", result.fullOutput, sessionMeta, cwd, composedPrompt);
        log.info(this.worker.tag, `Issue done: ${issueId} (exit=0, session=${result.sessionId ?? "none"})`);
      } else {
        this.worker.sendUpdate(issueId, "failed", `Exit ${result.exitCode}\n${result.fullOutput}`, sessionMeta, cwd, composedPrompt);
        log.info(this.worker.tag, `Issue failed: ${issueId} (exit=${result.exitCode})`);
      }
    } catch (err: any) {
      if (task.aborted) {
        // 走异常路径的中断/取消(理论上 executor 都走 resolve,catch 是兜底)。
        // 同 try 块,事件已由 API 落库,worker 不再二次 sendUpdate。
        log.info(this.worker.tag, `Issue aborted via exception: ${issueId} (interrupted=${!!task.interrupted})`);
      } else {
        this.worker.sendUpdate(issueId, "failed", err.message, undefined, cwd);
        log.error(this.worker.tag, `Issue error: ${issueId}`, err.message);
      }
    } finally {
      // 强制 flush 累积 usage:覆盖所有路径(正常完成/abort/catch)。override
      // 用 result.usage(终态汇总值,口径与 reload 后 issue.usage 一致),保证
      // 最后一次推送与 DB 终态值对齐,避免数字回退。result 为 undefined 时
      // (execute 抛错)用累积值兜底。
      this.worker.flushIssueUsage(issueId, result?.usage);
      this.worker.activeTasks.delete(issueId);
      for (const [approvalId, p] of this.worker.pendingApprovals) {
        if (p.issueId !== issueId) continue;
        this.worker.pendingApprovals.delete(approvalId);
        p.resolve({ decision: "deny" });
      }
      // 取消的任务丢弃排队 append(用户主动放弃,不该再触发续跑);
      // 正常 / 失败 / 中断才消费队列起新一轮。中断(interrupted)与取消的
      // 区别:中断保留 session 并消费队列(对齐 codex ESC + flush steers),
      // 取消则整体作废。
      const queued = this.worker.pendingAppends.get(issueId);
      this.worker.pendingAppends.delete(issueId);
      const shouldConsumeQueue = !task.aborted || !!task.interrupted;
      if (queued && queued.length > 0 && shouldConsumeQueue) {
        const merged = queued.join("\n\n");
        log.info(this.worker.tag, `Issue append consuming queue: ${issueId} (count=${queued.length}, session=${lastSessionId ?? "(none)"}, interrupted=${!!task.interrupted})`);
        // setImmediate 避免在 finally 同步链上递归调起新一轮。
        // 队列消费继承本轮的 effectivePolicy；append 自己的 ws 消息此时已经在
        // 队列里被吃掉，没机会再传策略，沿用本轮是正确做法（用户切换策略后
        // 新的 issue_append 会重新走 ws → effectivePolicy 才会刷新）。
        setImmediate(() => {
          // append 续跑也走 system-prompt 通道:重 compose 出静态层(role+cwd)随
          // systemPrompt 重传,merged 作为 userMessage。否则 claude/codex/pi 这类
          // 每轮重算 system prompt 的 backend 在 resume 时会丢静态上下文。
          const appendComposed = composePrompt({
            mode: "issue",
            agentName: this.worker.config.name,
            agentProfile: this.worker.agentProfile,
            group: null,
            cwd,
            body: merged,
            approvalPolicy: effectivePolicy,
          });
          this.runIssueExecution(issueId, appendComposed.userMessage, cwd, lastSessionId, slashCommand, effectivePolicy, appendComposed);
        });
      } else if (task.aborted && task.interrupted) {
        // 中断 + 队列空:issue 没有新一轮要跑,转 paused(待继续)状态。
        // 否则 master 上 issue.status 会一直停在 in_progress,Dashboard
        // loading 转不停。session_id 已在 issue 表里,用户下次 append 时
        // worker 走 idle 分支用 --resume 续跑。
        // 不传 content:避免把状态变更伪装成 agent 对话气泡(参考上面
        // task.aborted 早返回路径的同款注释)。
        log.info(this.worker.tag, `Issue interrupted idle → paused: ${issueId} (session=${lastSessionId ?? "(none)"})`);
        this.worker.sendUpdate(issueId, "paused", undefined, undefined, cwd);
      }
    }
  }

  extractArtifacts(output: string): string[] {
    const artifacts: string[] = [];
    const patterns = [
      /(?:created|modified|wrote|updated)\s+`?([^\s`]+\.\w+)`?/gi,
      /(?:Editing|Creating)\s+([^\s:]+\.\w+)/gi,
    ];
    for (const p of patterns) {
      let m;
      while ((m = p.exec(output)) !== null) {
        if (!artifacts.includes(m[1])) artifacts.push(m[1]);
      }
    }
    return artifacts;
  }
}
