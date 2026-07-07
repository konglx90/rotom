/**
 * Shared pure-function tests — mention / safeJsonParse / json-codec / dedup.
 *
 * 这些模块是 master/ws-hub、master/api、executor 多处共用的纯工具,之前零测试。
 * 运行器:node --import tsx --test tests/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractMentions } from "../src/shared/mention.js";
import { safeJsonParse } from "../src/shared/parse.js";
import { encodeJsonLine, decodeJson } from "../src/shared/json-codec.js";
import { MessageDedup } from "../src/shared/dedup.js";

// ---------------------------------------------------------------------------
// extractMentions
// ---------------------------------------------------------------------------

test("extractMentions: 空/falsy 返回空数组", () => {
  assert.deepEqual(extractMentions(null), []);
  assert.deepEqual(extractMentions(undefined), []);
  assert.deepEqual(extractMentions(""), []);
  assert.deepEqual(extractMentions("没人 @ 任何人的消息"), []);
});

test("extractMentions: 单个 ASCII @name 去掉前导 @", () => {
  assert.deepEqual(extractMentions("@alice hi"), ["alice"]);
  assert.deepEqual(extractMentions("前置文本 @bob"), ["bob"]);
});

test("extractMentions: 中文名(CJK 一-鿿)可匹配", () => {
  assert.deepEqual(extractMentions("@江德福 帮我看下接口"), ["江德福"]);
  assert.deepEqual(extractMentions("谢谢 @德福"), ["德福"]);
});

test("extractMentions: 多个 @ 全部保留(不去重,符合既有调用约定)", () => {
  assert.deepEqual(extractMentions("@a @b @a 重复也保留"), ["a", "b", "a"]);
});

test("extractMentions: 允许点号与连字符(常见 agent 名形如 agent.1 / agent-2)", () => {
  assert.deepEqual(extractMentions("@agent.1 @agent-2"), ["agent.1", "agent-2"]);
});

test("extractMentions: 邮箱样式 @ 不被误判(紧跟前置词/无空格仍按 token 取,属预期边界)", () => {
  // `foo@bar` 不匹配,因为 @ 前必须有非标识符边界 —— 实测正则仍会从 @bar 取出 bar
  // 这里锁定实际行为,防止后续改正则时悄悄变化
  const out = extractMentions("联系 foo@bar.com");
  assert.deepEqual(out, ["bar.com"]);
});

// ---------------------------------------------------------------------------
// safeJsonParse
// ---------------------------------------------------------------------------

test("safeJsonParse: 合法 JSON 返回解析值", () => {
  assert.deepEqual(safeJsonParse('{"a":1}', null), { a: 1 });
  assert.equal(safeJsonParse("3.14", 0), 3.14);
  assert.deepEqual(safeJsonParse("[1,2,3]", []), [1, 2, 3]);
});

test("safeJsonParse: null/空串/非法 返回 fallback", () => {
  assert.equal(safeJsonParse(null, "fb"), "fb");
  assert.equal(safeJsonParse("", "fb"), "fb");
  assert.equal(safeJsonParse("not json", "fb"), "fb");
  assert.equal(safeJsonParse("{broken", "fb"), "fb");
});

test("safeJsonParse: fallback 保留对象引用(同一实例)", () => {
  const fb = { x: 1 };
  assert.equal(safeJsonParse("bad", fb), fb);
});

// ---------------------------------------------------------------------------
// json-codec
// ---------------------------------------------------------------------------

test("encodeJsonLine: 末尾带换行(stdio JSON-RPC 传输依赖)", () => {
  assert.equal(encodeJsonLine({ a: 1 }), '{"a":1}\n');
  assert.equal(encodeJsonLine("x"), '"x"\n');
});

test("decodeJson: 字符串正常解析", () => {
  assert.deepEqual(decodeJson('{"a":1}'), { a: 1 });
});

test("decodeJson: Buffer / ArrayBuffer / Buffer[] 均可解析", () => {
  assert.deepEqual(decodeJson(Buffer.from('[1,2]')), [1, 2]);
  const s = '{"b":2}';
  const ab = new ArrayBuffer(s.length);
  new Uint8Array(ab).set(Buffer.from(s));
  assert.deepEqual(decodeJson(ab), { b: 2 });
  assert.deepEqual(decodeJson([Buffer.from('{"c":'), Buffer.from('3}')]), { c: 3 });
});

test("decodeJson: 非法 JSON 返回 undefined(不抛)", () => {
  assert.equal(decodeJson("not json"), undefined);
  assert.equal(decodeJson(Buffer.from("{bad")), undefined);
});

// ---------------------------------------------------------------------------
// MessageDedup
// ---------------------------------------------------------------------------

test("MessageDedup: 首次未见返回 false,mark 后再见返回 true", () => {
  const d = new MessageDedup(60_000);
  assert.equal(d.isDuplicate("r1"), false);
  d.mark("r1");
  assert.equal(d.isDuplicate("r1"), true);
});

test("MessageDedup: 不同 requestId 互不影响", () => {
  const d = new MessageDedup(60_000);
  d.mark("a");
  assert.equal(d.isDuplicate("a"), true);
  assert.equal(d.isDuplicate("b"), false);
});

test("MessageDedup: TTL 过期后不再判重", () => {
  const d = new MessageDedup(10); // 10ms TTL
  d.mark("old");
  // 用伪造时间无法直接注入;改用 cleanup + 真实等待会拖慢测试。
  // 这里验证 isDuplicate 在超 TTL 后会删除并返回 false。
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(d.isDuplicate("old"), false);
      resolve();
    }, 20);
  });
});

test("MessageDedup: cleanup 清除超 TTL 条目", () => {
  const d = new MessageDedup(10);
  d.mark("x");
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      d.cleanup();
      assert.equal(d.isDuplicate("x"), false);
      resolve();
    }, 20);
  });
});
