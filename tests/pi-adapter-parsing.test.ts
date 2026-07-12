/**
 * Pi 适配器纯函数离线夹具测试(B2)。
 *
 * 重点测 pi 的 tool-call markup 净化状态机(从 multica pi.go 移植,最复杂、
 * 0% 覆盖),以及 usage 累积 / 工具状态映射 / 结果文本抽取。全部纯函数,不起子进程。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  stripPiToolCallMarkup,
  stripPiControlTokens,
  stripPiStructuredToolMarkup,
  drainPiSanitizedText,
  PiTextBuffer,
  looksLikePiControlTokenPrefix,
  safePiTextEmitLen,
  toolStatusFor,
  extractToolResultText,
  accumulatePiUsage,
  type PiMessage,
} from "../src/executor/executors/pi.js";

// ── stripPiControlTokens ─────────────────────────────────────────────────

describe("pi stripPiControlTokens", () => {
  it("剥除 <|name> 形态(无闭合 pipe)", () => {
    assert.equal(stripPiControlTokens("<|im_start>"), "");
  });
  it("剥除 <name|> 形态(含 <tool_call|> 尾标)", () => {
    assert.equal(stripPiControlTokens("a <tool_call|> b"), "a  b");
    assert.equal(stripPiControlTokens("<im_end|>"), "");
  });
  it("<|name|> 双 pipe 形态当前不被剥除(记录现状)", () => {
    // 正则只覆盖 <|name> 与 <name|>,不覆盖标准 tokenizer 的 <|name|>。
    // 真实 pi 流里这类 token 由上游 text_delta 形态决定;此处锁定现状。
    assert.equal(stripPiControlTokens("hello <|im_end|> world"), "hello <|im_end|> world");
  });
  it("无控制 token 的文本原样返回", () => {
    assert.equal(stripPiControlTokens("普通文本 no tokens"), "普通文本 no tokens");
  });
});

// ── stripPiStructuredToolMarkup / stripPiToolCallMarkup ──────────────────

describe("pi stripPiToolCallMarkup (结构化 tool-call 块)", () => {
  it("剥除完整 call: 块", () => {
    assert.equal(stripPiStructuredToolMarkup('前置文本 call:bash{"cmd":"ls"}<tool_call|> 后置'), "前置文本  后置");
  });
  it("剥除嵌套 JSON 大括号的块", () => {
    assert.equal(stripPiStructuredToolMarkup('call:bash{"a":{"b":1}}<tool_call|>'), "");
  });
  it("未闭合块保留原样(等更多 delta)", () => {
    assert.equal(stripPiStructuredToolMarkup("call:bash{不完整"), "call:bash{不完整");
  });
  it("剥除 response:name{...} 块", () => {
    assert.equal(stripPiStructuredToolMarkup('response:final{"ok":true}<tool_call|>.'), ".");
  });
  it("response 后无 name 时不是合法 markup,原样保留(记录现状)", () => {
    // 合法块要求 prefix 后有工具名再接 {。response:{...} 直接接括号 → 不识别。
    assert.equal(stripPiStructuredToolMarkup('response:{"ok":true}<tool_call|>.'), 'response:{"ok":true}<tool_call|>.');
  });
  it("无 markup 原样返回", () => {
    assert.equal(stripPiStructuredToolMarkup("just prose"), "just prose");
  });
  it("stripPiToolCallMarkup 同时去结构化块 + <tool_call|> 尾标", () => {
    assert.equal(
      stripPiToolCallMarkup('答 call:bash{"x":1}<tool_call|> 完'),
      "答  完",
    );
  });
});

// ── drainPiSanitizedText ─────────────────────────────────────────────────

describe("pi drainPiSanitizedText", () => {
  it("完整文本:emit 全部,pending 空", () => {
    const [emit, pending] = drainPiSanitizedText("hello world");
    assert.equal(emit, "hello world");
    assert.equal(pending, "");
  });
  it("尾部疑似 call: 前缀:hold 住,pending 带回头", () => {
    const [emit, pending] = drainPiSanitizedText("hi cal");
    assert.equal(emit, "hi ");
    assert.equal(pending, "cal");
  });
  it("完整块被吃掉,前后文本 emit", () => {
    const [emit, pending] = drainPiSanitizedText('a call:bash{"q":1}<tool_call|> b');
    assert.equal(emit, "a  b");
    assert.equal(pending, "");
  });
});

// ── PiTextBuffer (流式) ──────────────────────────────────────────────────

describe("pi PiTextBuffer (流式增量净化)", () => {
  it("跨 chunk 的完整文本:逐步 append 拼出净化结果", () => {
    const buf = new PiTextBuffer();
    assert.equal(buf.append("hello "), "hello ");
    assert.equal(buf.append("world"), "world");
    assert.equal(buf.flush(), "");
  });
  it("被 chunk 切断的 call: 前缀:先 hold,补齐后剥除整块", () => {
    const buf = new PiTextBuffer();
    // "cal" 是 "call:" 的前缀 → 应 hold 回
    const e1 = buf.append("text cal");
    assert.equal(e1, "text ");
    // 补齐成完整块 → 整块剥除,不 emit 任何 markup
    const e2 = buf.append('l:bash{"cmd":"rm -rf"}<tool_call|>');
    assert.equal(e2, "");
    assert.equal(buf.flush(), "");
  });
  it("flush 把 hold 住的疑似前缀(最终不是 markup)吐出", () => {
    const buf = new PiTextBuffer();
    assert.equal(buf.append("hi cal"), "hi "); // "cal" 被当成 call: 前缀 hold 回
    assert.equal(buf.flush(), "cal");          // flush 确认不是合法 markup → 吐出原文
  });
});

// ── safePiTextEmitLen / looksLikePiControlTokenPrefix ────────────────────

describe("pi 部分前缀探测", () => {
  it("looksLikePiControlTokenPrefix:识别 <|foo 未闭合", () => {
    assert.equal(looksLikePiControlTokenPrefix("<|im_end"), true);
    assert.equal(looksLikePiControlTokenPrefix("<|"), true);
    assert.equal(looksLikePiControlTokenPrefix("普通"), false);
    assert.equal(looksLikePiControlTokenPrefix(""), false);
    assert.equal(looksLikePiControlTokenPrefix("<" + "x".repeat(100)), false, ">64 chars not a prefix");
  });
  it("safePiTextEmitLen:尾部 call: 前缀被 hold", () => {
    // "x cal" → 末尾 "cal" 是 "call:".slice(0,3),hold 3 → 可 emit 2 字符("x ")
    assert.equal(safePiTextEmitLen("x cal"), 2);
    assert.equal(safePiTextEmitLen("无前缀文本"), 5);
  });
});

// ── toolStatusFor ────────────────────────────────────────────────────────

describe("pi toolStatusFor", () => {
  it("写类工具 → Patching", () => {
    assert.equal(toolStatusFor("edit"), "Patching");
    assert.equal(toolStatusFor("write"), "Patching");
  });
  it("bash → Running", () => {
    assert.equal(toolStatusFor("bash"), "Running");
  });
  it("只读类 → Reading", () => {
    assert.equal(toolStatusFor("read"), "Reading");
    assert.equal(toolStatusFor("grep"), "Reading");
    assert.equal(toolStatusFor("find"), "Reading");
    assert.equal(toolStatusFor("ls"), "Reading");
  });
  it("未知工具默认 Running;undefined 默认 Running", () => {
    assert.equal(toolStatusFor("unknown_tool"), "Running");
    assert.equal(toolStatusFor(undefined), "Running");
  });
});

// ── extractToolResultText ────────────────────────────────────────────────

describe("pi extractToolResultText", () => {
  it("字符串结果原样返回", () => {
    assert.equal(extractToolResultText("done"), "done");
  });
  it("对象优先取 text,其次 output", () => {
    assert.equal(extractToolResultText({ text: "t" }), "t");
    assert.equal(extractToolResultText({ output: "o" }), "o");
    assert.equal(extractToolResultText({ text: "t", output: "o" }), "t");
  });
  it("null/undefined → undefined", () => {
    assert.equal(extractToolResultText(null), undefined);
    assert.equal(extractToolResultText(undefined), undefined);
  });
  it("无 text/output 的对象:JSON 兜底", () => {
    assert.equal(extractToolResultText({ foo: 1 }), '{"foo":1}');
  });
});

// ── accumulatePiUsage ────────────────────────────────────────────────────

describe("pi accumulatePiUsage", () => {
  it("msg 无 usage:原样返回 prev", () => {
    assert.equal(accumulatePiUsage(undefined, { role: "x" }), undefined);
    const prev = { inputTokens: 10, outputTokens: 5 };
    assert.equal(accumulatePiUsage(prev, { model: "m" }), prev);
  });
  it("首次累积(prev undefined)", () => {
    const u = accumulatePiUsage(undefined, { usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165 } });
    assert.equal(u.inputTokens, 100);
    assert.equal(u.outputTokens, 50);
    assert.equal(u.cacheReadTokens, 10);
    assert.equal(u.cacheCreationTokens, 5);
  });
  it("多次 turn_end 累加", () => {
    const msg = { usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165 } };
    const u1 = accumulatePiUsage(undefined, msg);
    const u2 = accumulatePiUsage(u1, msg);
    assert.equal(u2.inputTokens, 200);
    assert.equal(u2.outputTokens, 100);
  });
  it("totalCostUsd 从 prev 透传(pi 不上报成本)", () => {
    const prev = { inputTokens: 1, totalCostUsd: 0.5 };
    const u = accumulatePiUsage(prev, { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
    assert.equal(u.totalCostUsd, 0.5);
  });
});
