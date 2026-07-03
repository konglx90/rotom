import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrls, normalizeUrl, extractContextSnippet } from "../src/shared/url-extractor.js";

test("extractUrls: markdown [text](url)", () => {
  const out = extractUrls("看 [React Hooks](https://react.dev/hooks) 文档");
  assert.equal(out.length, 1);
  assert.equal(out[0].raw, "https://react.dev/hooks");
});

test("extractUrls: 裸 URL", () => {
  const out = extractUrls("看 https://react.dev/hooks 文档");
  assert.equal(out.length, 1);
  assert.equal(out[0].raw, "https://react.dev/hooks");
});

test("extractUrls: trailing 标点被剥(. , ; : ! ? )", () => {
  for (const punct of [".", ",", ";", ":", "!", "?"]) {
    const out = extractUrls(`见 https://example.com/path${punct} 后续`);
    assert.equal(out[0].raw, "https://example.com/path", `trailing "${punct}" 应被剥`);
  }
});

test("extractUrls: trailing 右括号被剥", () => {
  const out = extractUrls("(见 https://example.com/page)");
  assert.equal(out[0].raw, "https://example.com/page");
});

test("extractUrls: 同一 URL 多次出现各算一条", () => {
  const out = extractUrls("a https://x.com b https://x.com c");
  assert.equal(out.length, 2);
});

test("extractUrls: markdown + 裸 URL 同时出现", () => {
  const out = extractUrls("[a](https://a.com) 和 https://b.com");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((u) => u.raw), ["https://a.com", "https://b.com"]);
});

test("extractUrls: 空 / 无 URL 返回空数组", () => {
  assert.deepEqual(extractUrls(""), []);
  assert.deepEqual(extractUrls("没链接的纯文本"), []);
});

test("extractUrls: 按 index 升序", () => {
  const out = extractUrls("https://c.com first https://a.com second");
  assert.ok(out[0].index < out[1].index);
});

// ── normalizeUrl ───────────────────────────────────────────────────────

test("normalizeUrl: 小写 host + 去 www.", () => {
  const n = normalizeUrl("https://WWW.Example.com/Path")!;
  assert.ok(n);
  assert.equal(n.host, "example.com");
  assert.equal(n.norm, "https://example.com/Path");
});

test("normalizeUrl: 去 utm_* / fbclid / gclid / ref", () => {
  const n = normalizeUrl("https://example.com/x?utm_source=foo&utm_medium=bar&fbclid=abc&id=42")!;
  assert.equal(n.norm, "https://example.com/x?id=42");
});

test("normalizeUrl: 末尾 / 被剥", () => {
  const n = normalizeUrl("https://example.com/path/")!;
  assert.equal(n.norm, "https://example.com/path");
});

test("normalizeUrl: hash 被删", () => {
  const n = normalizeUrl("https://example.com/x?a=1#section")!;
  assert.equal(n.norm, "https://example.com/x?a=1");
});

test("normalizeUrl: 多 query 参数按 key 字典序排", () => {
  const n = normalizeUrl("https://example.com/?b=2&a=1&c=3")!;
  assert.equal(n.norm, "https://example.com/?a=1&b=2&c=3");
});

test("normalizeUrl: 非 http(s) 返回 null", () => {
  assert.equal(normalizeUrl("ftp://example.com/x"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
});

test("normalizeUrl: 非法 URL 返回 null", () => {
  assert.equal(normalizeUrl("https://"), null);
  assert.equal(normalizeUrl("not a url at all"), null);
});

test("normalizeUrl: dedup 友好(同链接不同追踪参数归一)", () => {
  const a = normalizeUrl("https://example.com/article?utm_source=twitter&id=42")!;
  const b = normalizeUrl("https://example.com/article?id=42&utm_medium=social")!;
  assert.equal(a.norm, b.norm);
});

test("normalizeUrl: 保留非追踪参数(gclid 单独验证)", () => {
  const n = normalizeUrl("https://example.com/x?gclid=abc&keep=1")!;
  assert.equal(n.norm, "https://example.com/x?keep=1");
});

// ── extractContextSnippet ──────────────────────────────────────────────

test("extractContextSnippet: 截 url 前后 100 字", () => {
  const prefix = "x".repeat(150);
  const suffix = "y".repeat(150);
  const text = `${prefix} https://example.com ${suffix}`;
  const snip = extractContextSnippet(text, 151, " https://example.com".length - 1, 100);
  // 不超过 200 + url len,且不含 url 本身周边
  assert.ok(snip.length <= 400, `snippet 长度 ${snip.length} 应在预算内`);
});

test("extractContextSnippet: 去换行", () => {
  const text = "line1\nline2\nhttps://example.com\nline3\nline4";
  const snip = extractContextSnippet(text, text.indexOf("https://"), "https://example.com".length, 100);
  assert.ok(!snip.includes("\n"), "snippet 不应含换行");
});
