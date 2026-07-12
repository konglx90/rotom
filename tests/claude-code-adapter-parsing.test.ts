/**
 * Claude Code 适配器纯函数离线夹具测试(B2)。
 *
 * 覆盖:PreToolUse → 审批输入翻译(describeToolCall,最复杂)、tool_use 日志归一化
 * (describeToolUseForLog)、TodoWrite 规范化(normalizeTodos)、tool_result 文本抽取
 * (flattenToolResultContent)、字节截断(truncateForDiff)、patch diff body、
 * result 事件 usage 解析、session 解析、project 目录编码。全纯函数,不起子进程。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseClaudeResultUsage,
  describeToolCall,
  describeToolUseForLog,
  normalizeTodos,
  flattenToolResultContent,
  truncateForDiff,
  buildPatchLogBody,
  claudeProjectDir,
} from "../src/executor/executors/claude-code.js";
import { resolveSessionId } from "../src/executor/adapter-helpers.js";

// ── parseClaudeResultUsage ───────────────────────────────────────────────

describe("claude-code parseClaudeResultUsage", () => {
  it("snake_case usage + total_cost_usd 映射", () => {
    const u = parseClaudeResultUsage({
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      total_cost_usd: 0.42,
    });
    assert.equal(u.inputTokens, 10);
    assert.equal(u.outputTokens, 20);
    assert.equal(u.cacheReadTokens, 5);
    assert.equal(u.cacheCreationTokens, 3);
    assert.equal(u.totalCostUsd, 0.42);
  });
  it("缺 usage 对象 → undefined", () => {
    assert.equal(parseClaudeResultUsage({}), undefined);
    assert.equal(parseClaudeResultUsage({ usage: null }), undefined);
  });
  it("字段非 number → undefined(不误采信字符串)", () => {
    const u = parseClaudeResultUsage({ usage: { input_tokens: "10" } });
    assert.equal(u.inputTokens, undefined);
  });
});

// ── describeToolCall (PreToolUse → 审批输入) ─────────────────────────────

describe("claude-code describeToolCall", () => {
  it("Bash → exec(summary 含 description 优先,否则 command)", () => {
    const a = describeToolCall("Bash", { command: "ls", description: "列目录" });
    assert.equal(a.kind, "exec");
    assert.equal(a.command, "ls");
    assert.match(a.summary, /列目录/);
  });
  it("Bash 无 description:summary 落 command,超长截断", () => {
    const long = "x".repeat(300);
    const a = describeToolCall("Bash", { command: long });
    assert.match(a.summary, /…$/);
    assert.ok(a.summary.length < long.length);
  });
  it("Edit → file_change + diff(单 hunk)", () => {
    const a = describeToolCall("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" });
    assert.equal(a.kind, "file_change");
    assert.deepEqual(a.files, ["/a.ts"]);
    assert.equal(a.diff.tool, "Edit");
    assert.equal(a.diff.hunks.length, 1);
    assert.match(a.summary, /请求编辑文件/);
  });
  it("MultiEdit → 多 hunk,summary 含修改处数", () => {
    const a = describeToolCall("MultiEdit", {
      file_path: "/b.ts",
      edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }],
    });
    assert.equal(a.diff.hunks.length, 2);
    assert.match(a.summary, /2 处修改/);
  });
  it("Write → file_change + new_content,summary 含字符数", () => {
    const a = describeToolCall("Write", { file_path: "/c.ts", content: "hello" });
    assert.equal(a.kind, "file_change");
    assert.equal(a.diff.new_content, "hello");
    assert.match(a.summary, /5 字符/);
  });
  it("AskUserQuestion → ask + questions 结构", () => {
    const a = describeToolCall("AskUserQuestion", {
      questions: [{ question: "选哪个?", header: "H", multiSelect: false, options: [{ label: "A", description: "d" }] }],
    });
    assert.equal(a.kind, "ask");
    assert.equal(a.questions.length, 1);
    assert.equal(a.questions[0].options.length, 1);
    assert.match(a.summary, /选哪个/);
  });
  it("ExitPlanMode → plan,summary 取首行标题", () => {
    const a = describeToolCall("ExitPlanMode", { plan: "## 方案A\n正文" });
    assert.equal(a.kind, "plan");
    assert.equal(a.plan, "## 方案A\n正文");
    assert.match(a.summary, /方案A/);
  });
  it("未知写类(NotebookEdit 走默认 file_change 分支)", () => {
    const a = describeToolCall("NotebookEdit", { notebook_path: "/n.ipynb", new_source: "cell" });
    assert.equal(a.kind, "file_change");
    assert.equal(a.diff.new_content, "cell");
  });
});

// ── describeToolUseForLog ────────────────────────────────────────────────

describe("claude-code describeToolUseForLog", () => {
  it("写类(Edit/Write/MultiEdit/NotebookEdit)→ patch", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const r = describeToolUseForLog(name, { file_path: "/x" });
      assert.equal(r.kind, "patch", `${name} should be patch`);
    }
  });
  it("Bash → exec, label=command", () => {
    const r = describeToolUseForLog("Bash", { command: "npm test" });
    assert.equal(r.kind, "exec");
    assert.equal(r.label, "npm test");
  });
  it("Read → exec, label=Read <path>", () => {
    assert.equal(describeToolUseForLog("Read", { file_path: "/a.ts" }).label, "Read /a.ts");
  });
  it("Grep → exec, label 含 pattern", () => {
    const r = describeToolUseForLog("Grep", { pattern: "TODO" });
    assert.match(r.label, /Grep.*TODO/);
  });
  it("AskUserQuestion → ask", () => {
    assert.equal(describeToolUseForLog("AskUserQuestion", { questions: [] }).kind, "ask");
  });
  it("未知工具 → exec, label=name", () => {
    const r = describeToolUseForLog("Whatever", {});
    assert.equal(r.kind, "exec");
    assert.equal(r.label, "Whatever");
  });
});

// ── normalizeTodos ───────────────────────────────────────────────────────

describe("claude-code normalizeTodos", () => {
  it("非数组 → null", () => {
    assert.equal(normalizeTodos(undefined), null);
    assert.equal(normalizeTodos("nope"), null);
  });
  it("正常数组映射,status 三态收敛", () => {
    const todos = normalizeTodos([
      { content: "a", status: "in_progress", activeForm: "doing a" },
      { content: "b", status: "completed" },
      { content: "c", status: "pending" },
    ]);
    assert.equal(todos.length, 3);
    assert.equal(todos[0].status, "in_progress");
    assert.equal(todos[0].activeForm, "doing a");
    assert.equal(todos[1].status, "completed");
    assert.equal(todos[2].status, "pending");
  });
  it("未知 status 映射到 pending", () => {
    const todos = normalizeTodos([{ content: "x", status: "weird" }]);
    assert.equal(todos[0].status, "pending");
  });
  it("空 content 跳过;全空 → null", () => {
    assert.equal(normalizeTodos([{ content: "" }, { noContent: true }]), null);
  });
  it("缺失 activeForm 时不存在该字段", () => {
    const todos = normalizeTodos([{ content: "x", status: "pending" }]);
    assert.equal("activeForm" in todos[0], false);
  });
});

// ── flattenToolResultContent ─────────────────────────────────────────────

describe("claude-code flattenToolResultContent", () => {
  it("字符串原样返回", () => {
    assert.equal(flattenToolResultContent("plain"), "plain");
  });
  it("文本块数组按 \\n 拼接", () => {
    const out = flattenToolResultContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    assert.equal(out, "a\nb");
  });
  it("非数组非字符串 → 空串", () => {
    assert.equal(flattenToolResultContent(42), "");
    assert.equal(flattenToolResultContent(undefined), "");
  });
});

// ── truncateForDiff (字节感知) ───────────────────────────────────────────

describe("claude-code truncateForDiff", () => {
  it("未超限:原样 + truncated=false", () => {
    const r = truncateForDiff("short", 100);
    assert.equal(r.text, "short");
    assert.equal(r.truncated, false);
  });
  it("ASCII 超限:按字节比例截断 + 标记", () => {
    const r = truncateForDiff("x".repeat(100), 10);
    assert.equal(r.truncated, true);
    assert.match(r.text, /\.\.\. \(truncated\)$/);
    assert.ok(r.text.length < 100);
  });
  it("多字节:按字节比例(非字符数)截断", () => {
    // "中" = 3 bytes × 4 = 12 bytes,length 4。maxBytes=6 → floor(4*6/12)=2 字符 = 6 bytes。
    const r = truncateForDiff("中中中中", 6);
    assert.equal(r.truncated, true);
    assert.match(r.text, /\.\.\. \(truncated\)$/);
    assert.ok(r.text.startsWith("中中"), "keeps 2 multibyte chars (6 bytes), not more");
    assert.ok(!r.text.startsWith("中中中"));
  });
});

// ── buildPatchLogBody ────────────────────────────────────────────────────

describe("claude-code buildPatchLogBody", () => {
  it("Edit:含文件头 + -old + +new", () => {
    const body = buildPatchLogBody("Edit", { file_path: "/a.ts", old_string: "old", new_string: "new" });
    assert.match(body, /--- \/a\.ts/);
    assert.match(body, /\+\+\+ \/a\.ts/);
    assert.match(body, /^-old/m);
    assert.match(body, /^\+new/m);
  });
  it("Write:/dev/null 源 + +content", () => {
    const body = buildPatchLogBody("Write", { file_path: "/b.ts", content: "line1\nline2" });
    assert.match(body, /--- \/dev\/null/);
    assert.match(body, /^\+line1/m);
    assert.match(body, /^\+line2/m);
  });
  it("缺 file_path 用 (unknown file)", () => {
    const body = buildPatchLogBody("Edit", { old_string: "a", new_string: "b" });
    assert.match(body, /\(unknown file\)/);
  });
  it("超 50KB 截断", () => {
    const huge = "x".repeat(80_000);
    const body = buildPatchLogBody("Write", { file_path: "/c.ts", content: huge });
    assert.ok(Buffer.byteLength(body, "utf8") < 80_000);
    assert.match(body, /truncated/);
  });
});

// ── resolveSessionId / claudeProjectDir ──────────────────────────────────

describe("claude-code resolveSessionId", () => {
  it("与 codex 同语义:失败+resume+不同 → 空串", () => {
    assert.equal(resolveSessionId("s1", "s2", true), "");
    assert.equal(resolveSessionId("s1", "s1", false), "s1");
    assert.equal(resolveSessionId("", "s2", true), "s2");
  });
});

describe("claude-code claudeProjectDir", () => {
  it("把绝对路径里的 / 和 . 编码为 -", () => {
    const dir = claudeProjectDir("/Users/kong/ai-work/rotom");
    assert.ok(dir.includes(".claude/projects"), "should live under .claude/projects");
    assert.ok(dir.endsWith("-Users-kong-ai-work-rotom"), `got ${dir}`);
  });
  it("含 . 的路径(如 .rotom)也编码", () => {
    const dir = claudeProjectDir("/Users/kong/.rotom/artifacts");
    assert.ok(dir.endsWith("-Users-kong--rotom-artifacts"), `got ${dir}`);
  });
});
