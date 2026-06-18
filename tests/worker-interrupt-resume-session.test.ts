/**
 * Regression test for "interrupt + queue 消费时丢 sessionId" bug。
 *
 * 复现路径(worker.runIssueExecution):
 *   1. issue 跑第一轮,execute() 返回 sessionId='sess-1' 但被 interrupt
 *   2. 中断期间用户又 append 了一条 prompt(进 pendingAppends 队列)
 *   3. finally 块消费队列起新一轮,要把上一轮的 sessionId 当 --resume 入参
 *
 * 之前的 bug:`if (task.aborted) return` 早返回,`lastSessionId = result.sessionId`
 * 这行被跳过 → 队列续跑 lastSessionId=undefined → executor 起新会话,
 * 前一轮的工作全丢(用户面看到 "Starting with claude..." + "目前没有上下文")。
 *
 * 这里只验 executor 端的契约:第二轮 execute() 收到的 options.sessionId
 * 必须等于第一轮 result.sessionId。worker 整体单元依赖 ws/master 太重,
 * 这里把 worker 当黑盒,直接调私有 runIssueExecution 跑场景。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ExecutorWorker } from "../src/executor/worker.js";
import type { CliExecutor, ExecuteOptions, ExecuteResult } from "../src/executor/cli-executor.js";

interface CapturedCall {
  prompt: string;
  options: ExecuteOptions;
  resolve!: (r: ExecuteResult) => void;
}

function makeFakeExecutor() {
  const calls: CapturedCall[] = [];
  const executor: CliExecutor = {
    async execute(prompt: string, _cwd: string, _onOutput, options) {
      return new Promise<ExecuteResult>((resolve) => {
        calls.push({ prompt, options: options ?? {}, resolve });
      });
    },
  };
  return { executor, calls };
}

describe("ExecutorWorker.runIssueExecution — interrupt + queue 续跑保留 sessionId", () => {
  it("interrupt 期间 append 的 prompt 起新一轮时,options.sessionId 必须是上一轮返回的 sessionId", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-test-"));
    try {
      const { executor, calls } = makeFakeExecutor();
      const worker = new ExecutorWorker(
        { name: "西花-claude", token: "t", workingDir: tmpHome, cliTool: "claude" },
        executor,
        "ws://127.0.0.1:0",
        "claude",
        tmpHome,
      );
      const anyWorker = worker as any;

      const issueId = "issue-test-1";
      const groupId = "group-test";

      // 起第一轮(无 resumeSessionId)。executor.execute() 的 promise 挂住,
      // 模拟 claude 正在跑。fire-and-forget —— runIssueExecution 是 async,
      // 它会 await execute() 直到我们手动 resolve。
      void anyWorker.runIssueExecution(issueId, "原始任务", tmpHome, undefined, undefined, "rw_allow");
      await new Promise((r) => setImmediate(r));

      // 此时第一轮的 execute() 已挂在 calls[0]。模拟 master 推 issue_interrupt
      // 和 issue_append,这两步在真实流程里都来自 WS。
      anyWorker.handleMessage({ type: "issue_interrupt", issueId });
      anyWorker.handleMessage({
        type: "issue_append",
        issueId,
        prompt: "继续",
        sessionId: undefined,
        groupId,
      });

      // 让第一轮 execute() 返回 — claude 被 kill,但仍然 emit 过 session_id
      calls[0].resolve({ exitCode: 1, fullOutput: "(killed)", sessionId: "sess-1" });

      // finally 块用 setImmediate 调度新一轮的 runIssueExecution。
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // 断言:第二轮 execute() 被调用了,且 options.sessionId === 'sess-1'
      assert.equal(calls.length, 2, "第二轮 execute() 没被触发 — 队列消费失败");
      assert.equal(
        calls[1].options.sessionId,
        "sess-1",
        `第二轮 sessionId 应为 'sess-1',实际为 ${String(calls[1].options.sessionId)} — 上一轮的 session 丢了`,
      );

      // 收尾:resolve 第二轮的 promise 让 worker 退出 async,避免 unhandled rejection。
      calls[1].resolve({ exitCode: 0, fullOutput: "ok", sessionId: "sess-1" });
      await new Promise((r) => setImmediate(r));
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});
