/**
 * Codex 适配器纯函数离线夹具测试(B2 pilot)。
 *
 * codex 的 execute() 主体靠真子进程驱动,无法离线测;但它的一组「参数形状
 * 归一化」helper 是纯函数,恰恰也是 codex 各版本最容易静默出错的地方
 * (app-server 的 exec/file approval 参数改过好几次、usage 字段 camelCase)。
 * 这里用录制好的 params 夹具直接断言这些 helper 的输出,不起子进程。
 *
 * 覆盖:parseCodexTokenUsage / extractExecApprovalInput / extractFileApprovalInput
 *       / extractThreadId / resolveSessionId / prettyCommand。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseCodexTokenUsage,
  extractExecApprovalInput,
  extractFileApprovalInput,
  extractThreadId,
  prettyCommand,
} from "../src/executor/executors/codex.js";
import { resolveSessionId } from "../src/executor/adapter-helpers.js";

// ── parseCodexTokenUsage ─────────────────────────────────────────────────

describe("codex parseCodexTokenUsage", () => {
  it("把 camelCase total 字段映射到 TokenUsage", () => {
    const u = parseCodexTokenUsage({
      tokenUsage: {
        total: { inputTokens: 1234, outputTokens: 567, cachedInputTokens: 890 },
      },
    });
    assert.equal(u.inputTokens, 1234);
    assert.equal(u.outputTokens, 567);
    assert.equal(u.cacheReadTokens, 890);
    // codex 不上报这两项,恒为 undefined。
    assert.equal(u.cacheCreationTokens, undefined);
    assert.equal(u.totalCostUsd, undefined);
  });

  it("字符串 / null 字段归一化为 undefined;NaN 因 typeof===number 会被采信(记录现状)", () => {
    const u = parseCodexTokenUsage({
      tokenUsage: { total: { inputTokens: "1234", outputTokens: null, cachedInputTokens: NaN } },
    });
    assert.equal(u.inputTokens, undefined, "string should not be accepted");
    assert.equal(u.outputTokens, undefined, "null should not be accepted");
    // 现状:typeof NaN === 'number' 为 true,实现只校验 typeof,故 NaN 会漏网。
    // 这是已知的校验宽松点;若未来收紧(加 Number.isFinite),同步改本断言。
    assert.ok(Number.isNaN(u.cacheReadTokens), "NaN currently passes typeof check — documented laxness");
  });

  it("total / tokenUsage 缺失时返回全 undefined 的 TokenUsage(与原内联实现等价)", () => {
    const u = parseCodexTokenUsage({});
    assert.deepEqual(u, {
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
      totalCostUsd: undefined,
    });
  });

  it("字段为 0 时正常保留(0 是有效用量,不是缺失)", () => {
    const u = parseCodexTokenUsage({
      tokenUsage: { total: { inputTokens: 0, outputTokens: 0 } },
    });
    assert.equal(u.inputTokens, 0);
    assert.equal(u.outputTokens, 0);
  });
});

// ── extractExecApprovalInput ─────────────────────────────────────────────

describe("codex extractExecApprovalInput", () => {
  it("顶层 command 为字符串:正常取 + 剥 shell wrapper 进 summary", () => {
    const input = extractExecApprovalInput({
      command: "/bin/bash -lc 'git status'",
      cwd: "/repo",
    });
    assert.equal(input.kind, "exec");
    assert.equal(input.command, "git status");
    assert.equal(input.cwd, "/repo");
    assert.match(input.summary, /git status/);
  });

  it("command 为数组:join 成字符串", () => {
    const input = extractExecApprovalInput({ command: ["npm", "run", "build"] });
    assert.equal(input.command, "npm run build");
  });

  it("command 嵌套在 item 下:从 item 取,而非顶层", () => {
    const input = extractExecApprovalInput({ item: { command: "ls -la", cwd: "/tmp" } });
    assert.equal(input.command, "ls -la");
    assert.equal(input.cwd, "/tmp");
  });

  it("command 缺失但有 reason:summary 落到 reason", () => {
    const input = extractExecApprovalInput({ reason: "需要写文件" });
    assert.equal(input.command, undefined);
    assert.equal(input.summary, "需要写文件");
  });

  it("command 与 reason 都缺失:summary 走兜底文案", () => {
    const input = extractExecApprovalInput({});
    assert.equal(input.summary, "请求执行 shell 命令");
  });

  it("超长 command 在 summary 里截断(不污染 command 本身)", () => {
    const long = "x".repeat(300);
    const input = extractExecApprovalInput({ command: long });
    assert.equal(input.command, long);
    assert.ok(input.summary.length < long.length, "summary should truncate");
    assert.match(input.summary, /…$/);
  });
});

// ── extractFileApprovalInput ─────────────────────────────────────────────

describe("codex extractFileApprovalInput", () => {
  it("changes 为字符串数组:直接收集", () => {
    const input = extractFileApprovalInput({ changes: ["a.ts", "b.ts"] });
    assert.equal(input.kind, "file_change");
    assert.deepEqual(input.files, ["a.ts", "b.ts"]);
    assert.match(input.summary, /a\.ts/);
  });

  it("changes 为对象数组:从 path / file / targetPath 任一字段取", () => {
    const input = extractFileApprovalInput({
      changes: [
        { path: "src/a.ts" },
        { file: "src/b.ts" },
        { targetPath: "src/c.ts" },
        { unrelated: true }, // 无可识别路径字段 → 跳过
      ],
    });
    assert.deepEqual(input.files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("files 字段与 patch.changes 也参与收集(多来源合并)", () => {
    const input = extractFileApprovalInput({
      files: ["x.ts"],
      patch: { changes: [{ path: "y.ts" }] },
    });
    assert.deepEqual(input.files, ["x.ts", "y.ts"]);
  });

  it("无可识别文件:files 为 undefined,summary 走兜底", () => {
    const input = extractFileApprovalInput({});
    assert.equal(input.files, undefined);
    assert.equal(input.summary, "请求修改文件");
  });

  it("超过 3 个文件:summary 显示前 3 + 总数", () => {
    const input = extractFileApprovalInput({ changes: ["a", "b", "c", "d", "e"] });
    assert.match(input.summary, /共 5 项/);
  });
});

// ── extractThreadId ──────────────────────────────────────────────────────

describe("codex extractThreadId", () => {
  it("从 result.thread.id 取", () => {
    assert.equal(extractThreadId({ thread: { id: "th-123" } }), "th-123");
  });
  it("null / 非对象 / 缺 thread → 空串", () => {
    assert.equal(extractThreadId(null), "");
    assert.equal(extractThreadId("oops"), "");
    assert.equal(extractThreadId({}), "");
    assert.equal(extractThreadId({ thread: {} }), "");
    assert.equal(extractThreadId({ thread: { id: 123 } }), "", "non-string id ignored");
  });
});

// ── resolveSessionId ─────────────────────────────────────────────────────

describe("codex resolveSessionId", () => {
  it("正常:返回 emitted", () => {
    assert.equal(resolveSessionId("s1", "s1", false), "s1");
    assert.equal(resolveSessionId("", "s2", false), "s2");
  });
  it("失败 + resume 请求 + emitted 不同 → 空串(让上层重试新会话)", () => {
    assert.equal(resolveSessionId("s1", "s2", true), "");
  });
  it("失败但 emitted 与请求一致:仍返回 emitted(resume 落地了)", () => {
    assert.equal(resolveSessionId("s1", "s1", true), "s1");
  });
  it("失败但无 resume 请求:返回 emitted", () => {
    assert.equal(resolveSessionId("", "s2", true), "s2");
  });
});

// ── prettyCommand ────────────────────────────────────────────────────────

describe("codex prettyCommand", () => {
  it("剥 /bin/bash -lc '...' wrapper", () => {
    assert.equal(prettyCommand("/bin/bash -lc 'git commit -m \"x\"'"), 'git commit -m "x"');
  });
  it("剥 sh -lc \"...\" wrapper(双引号)", () => {
    assert.equal(prettyCommand('sh -lc "echo hi"'), "echo hi");
  });
  it("剥 zsh wrapper", () => {
    assert.equal(prettyCommand("zsh -lc 'npm test'"), "npm test");
  });
  it("普通命令原样返回(仅 trim)", () => {
    assert.equal(prettyCommand("  git status  "), "git status");
  });
  it("非 wrapper 的 -lc 不误剥", () => {
    // 形如 `foo -lc bar` 不是 shell wrapper,不应改写。
    assert.equal(prettyCommand("foo -lc bar"), "foo -lc bar");
  });
});
