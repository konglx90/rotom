/**
 * Adapter helpers 测试(Phase C 抽出的共享逻辑)。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveSessionId, sliceTail } from "../src/executor/adapter-helpers.js";

describe("adapter-helpers resolveSessionId", () => {
  it("正常:返回 emitted", () => {
    assert.equal(resolveSessionId("s1", "s1", false), "s1");
    assert.equal(resolveSessionId("", "s2", false), "s2");
  });
  it("失败 + resume 请求 + emitted 不同 → 空串(上层重开)", () => {
    assert.equal(resolveSessionId("s1", "s2", true), "");
  });
  it("失败但 emitted 与请求一致:仍返回(resume 落地了)", () => {
    assert.equal(resolveSessionId("s1", "s1", true), "s1");
  });
  it("失败但无 resume 请求:返回 emitted", () => {
    assert.equal(resolveSessionId("", "s2", true), "s2");
  });
});

describe("adapter-helpers sliceTail", () => {
  it("行数不足 tail:原样返回", () => {
    assert.equal(sliceTail("a\nb\nc", 200), "a\nb\nc");
    assert.equal(sliceTail("only one", 200), "only one");
  });
  it("行数超过 tail:取最后 N 行", () => {
    const text = "l1\nl2\nl3\nl4\nl5";
    assert.equal(sliceTail(text, 2), "l4\nl5");
    assert.equal(sliceTail(text, 3), "l3\nl4\nl5");
  });
  it("刚好等于 tail:原样返回(不截断)", () => {
    // "a\nb\nc".split("\n") = 3 行,tail=3 → 3 > 3 false → 原样
    assert.equal(sliceTail("a\nb\nc", 3), "a\nb\nc");
  });
  it("空串:原样", () => {
    assert.equal(sliceTail("", 10), "");
  });
  it("尾部空行计入行数(与原各适配器行为一致)", () => {
    // "a\nb\n".split("\n") = ["a","b",""] = 3 行;tail=2 → 取 ["b",""] → "b\n"...
    // 实际:.slice(-2) = ["b",""], join("\n") = "b\n"... 即 "b" + "\n" + ""
    assert.equal(sliceTail("a\nb\n", 2), "b\n");
  });
});
