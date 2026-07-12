/**
 * Hermes 适配器纯函数离线夹具测试(B2)。
 *
 * 覆盖:provider 错误嗅探(matchProviderError)、干净错误原因抽取
 * (extractCleanErrorReason)、ACP session/update 类型归一化(normalizeUpdateType
 * /normalizeTypeKey,从闭包上提)、content 渲染(stringifyContent)、env 清洗
 * (buildHermesEnv —— 文档化的 CCV/ANTHROPIC 泄漏修复)。全纯函数,不起子进程。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  matchProviderError,
  extractCleanErrorReason,
  normalizeUpdateType,
  normalizeTypeKey,
  stringifyContent,
  buildHermesEnv,
} from "../src/executor/executors/hermes-cli.js";

// ── matchProviderError ───────────────────────────────────────────────────

describe("hermes matchProviderError", () => {
  it("命中 'API call failed after N retries'", () => {
    assert.ok(matchProviderError("API call failed after 3 retries: Connection error."));
    assert.ok(matchProviderError("API call failed after 1 retry: x"));
  });
  it("命中 SDK 错误名 / Non-retryable / [ERROR]", () => {
    assert.ok(matchProviderError("raise APIConnectionError(...)"));
    assert.ok(matchProviderError("RateLimitError hit"));
    assert.ok(matchProviderError("Non-retryable: bad request"));
    assert.ok(matchProviderError("[ERROR] something"));
  });
  it("命中 4xx/5xx + 错误关键词", () => {
    assert.ok(matchProviderError("HTTP 503 error"));
    assert.ok(matchProviderError("HTTP 401 unauthorized"));
  });
  it("正常文本不命中", () => {
    assert.equal(matchProviderError("agent replied normally"), null);
    assert.equal(matchProviderError("the API returned a valid response"), null);
  });
});

// ── extractCleanErrorReason ──────────────────────────────────────────────

describe("hermes extractCleanErrorReason", () => {
  it("从 summary= 字段抽原因", () => {
    const reason = extractCleanErrorReason("2026-07-12 WARN agent summary=Connection error. | thread=x");
    assert.ok(reason.startsWith("Connection error"), `got ${reason}`);
  });
  it("从 ❌ 横幅抽原因", () => {
    const reason = extractCleanErrorReason("❌ API failed after 3 retries — Timeout.");
    assert.equal(reason, "Timeout");
  });
  it("从 💀 Final error 抽原因", () => {
    const reason = extractCleanErrorReason("💀 Final error: Boom.");
    assert.equal(reason, "Boom");
  });
  it("无可识别模式 → 兜底 'provider error'", () => {
    assert.equal(extractCleanErrorReason("some random unstructured line"), "provider error");
  });
  it("过长原因(<200)被跳过,落到兜底", () => {
    // summary= 后跟一长串无空格 token,长度超 200 → 该 pattern 不取,兜底。
    const long = "x".repeat(250);
    assert.equal(extractCleanErrorReason(`summary=${long}`), "provider error");
  });
});

// ── normalizeTypeKey / normalizeUpdateType ───────────────────────────────

describe("hermes normalizeTypeKey", () => {
  it("camelCase / kebab / snake 都归一到同一 canonical", () => {
    assert.equal(normalizeTypeKey("agentMessageChunk"), "agent_message_chunk");
    assert.equal(normalizeTypeKey("Agent-Message-Chunk"), "agent_message_chunk");
    assert.equal(normalizeTypeKey("agent_message_chunk"), "agent_message_chunk");
  });
  it("turn_end 接受 endturn 变体", () => {
    assert.equal(normalizeTypeKey("TurnEnd"), "turn_end");
    assert.equal(normalizeTypeKey("end-turn"), "turn_end");
  });
  it("未知 → 空串", () => {
    assert.equal(normalizeTypeKey("someNewUpdateType"), "");
  });
});

describe("hermes normalizeUpdateType", () => {
  it("读 sessionUpdate 字段", () => {
    assert.equal(normalizeUpdateType({ sessionUpdate: "agentMessageChunk", content: {} }), "agent_message_chunk");
  });
  it("读 type 字段(无 sessionUpdate 时)", () => {
    assert.equal(normalizeUpdateType({ type: "tool_call" }), "tool_call");
    assert.equal(normalizeUpdateType({ type: "TurnEnd" }), "turn_end");
  });
  it("外层 tag(单 key 对象)→ 取那个 key", () => {
    assert.equal(normalizeUpdateType({ agentThoughtChunk: { content: { text: "x" } } }), "agent_thought_chunk");
  });
  it("多 key 且无 sessionUpdate/type → 空串(无法判定)", () => {
    assert.equal(normalizeUpdateType({ foo: 1, bar: 2 }), "");
  });
  it("null/非对象 → 空串", () => {
    assert.equal(normalizeUpdateType(null), "");
    assert.equal(normalizeUpdateType(undefined), "");
    assert.equal(normalizeUpdateType("string"), "");
  });
});

// ── stringifyContent ─────────────────────────────────────────────────────

describe("hermes stringifyContent", () => {
  it("字符串原样", () => {
    assert.equal(stringifyContent("hi"), "hi");
  });
  it("文本块数组按 \\n 拼", () => {
    assert.equal(stringifyContent([{ text: "a" }, { text: "b" }]), "a\nb");
  });
  it("无 text 字段的块走 JSON 兜底", () => {
    assert.equal(stringifyContent([{ foo: 1 }]), '{"foo":1}');
  });
  it("对象走 JSON", () => {
    assert.equal(stringifyContent({ a: 1 }), '{"a":1}');
  });
  it("null → 空串(content ?? '')", () => {
    assert.equal(stringifyContent(null), "");
  });
});

// ── buildHermesEnv ───────────────────────────────────────────────────────

describe("hermes buildHermesEnv (CCV/ANTHROPIC 泄漏清洗)", () => {
  it("剥除 ANTHROPIC_* / CLAUDE_CODE_* / CLAUDECODE / CCV_PROXY_MODE", () => {
    const out = buildHermesEnv(
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:58082",
        ANTHROPIC_AUTH_TOKEN: "sk-leak",
        CLAUDE_CODE_SSE_PORT: "9",
        CLAUDECODE: "1",
        CCV_PROXY_MODE: "1",
        KEEP_ME: "kept",
        PATH: "/orig/bin",
      },
      { MY_OPT: "v" },
      "/merged/bin",
    );
    assert.equal(out.ANTHROPIC_BASE_URL, undefined, "ANTHROPIC_* must be stripped");
    assert.equal(out.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(out.CLAUDE_CODE_SSE_PORT, undefined);
    assert.equal(out.CLAUDECODE, undefined);
    assert.equal(out.CCV_PROXY_MODE, undefined);
    assert.equal(out.KEEP_ME, "kept", "unrelated vars preserved");
    assert.equal(out.MY_OPT, "v", "optionsEnv merged in");
    assert.equal(out.PATH, "/merged/bin", "PATH = mergedPath");
    assert.equal(out.HERMES_YOLO_MODE, "1", "yolo flag injected");
  });
  it("mergedPath 缺失时回退 parentEnv.PATH", () => {
    const out = buildHermesEnv({ PATH: "/orig" }, undefined, undefined);
    assert.equal(out.PATH, "/orig");
  });
});
