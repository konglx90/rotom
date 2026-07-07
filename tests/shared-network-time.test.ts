/**
 * Shared pure-function tests — network (isLoopback / isLocalNetwork) + time (Beijing).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isLoopback, isLocalNetwork } from "../src/shared/network.js";
import { toBeijing, toBeijingCompact, toBeijingYearMonth, shiftBeijing } from "../src/shared/time.js";

// ---------------------------------------------------------------------------
// isLoopback
// ---------------------------------------------------------------------------

test("isLoopback: 127.0.0.1 / ::1 / IPv4-mapped 形式均判为 loopback", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
});

test("isLoopback: 非本机地址 / 空 / null 返回 false", () => {
  assert.equal(isLoopback("192.168.1.1"), false);
  assert.equal(isLoopback("10.0.0.5"), false);
  assert.equal(isLoopback(""), false);
  assert.equal(isLoopback(null), false);
  assert.equal(isLoopback(undefined), false);
});

// ---------------------------------------------------------------------------
// isLocalNetwork
// ---------------------------------------------------------------------------

test("isLocalNetwork: loopback 一并判可信", () => {
  assert.equal(isLocalNetwork("127.0.0.1"), true);
  assert.equal(isLocalNetwork("::ffff:127.0.0.1"), true);
});

test("isLocalNetwork: 192.168/10/172.16-31/30 段可信,含 IPv4-mapped", () => {
  assert.equal(isLocalNetwork("192.168.0.1"), true);
  assert.equal(isLocalNetwork("10.1.2.3"), true);
  assert.equal(isLocalNetwork("172.16.0.1"), true);
  assert.equal(isLocalNetwork("172.31.255.255"), true);
  assert.equal(isLocalNetwork("30.249.225.150"), true);
  // IPv4-mapped 前缀同样应被剥离后匹配
  assert.equal(isLocalNetwork("::ffff:192.168.1.5"), true);
  assert.equal(isLocalNetwork("::ffff:30.249.225.150"), true);
});

test("isLocalNetwork: 172.15 / 172.32 / 公网段 不可信", () => {
  assert.equal(isLocalNetwork("172.15.0.1"), false);
  assert.equal(isLocalNetwork("172.32.0.1"), false);
  assert.equal(isLocalNetwork("8.8.8.8"), false);
  assert.equal(isLocalNetwork("123.45.67.89"), false);
});

test("isLocalNetwork: 空 / null 返回 false", () => {
  assert.equal(isLocalNetwork(""), false);
  assert.equal(isLocalNetwork(null), false);
});

// ---------------------------------------------------------------------------
// time (北京时间,无视服务器时区)
// ---------------------------------------------------------------------------

test("toBeijing: 固定 UTC instant 输出北京时间(无视 process.env.TZ)", () => {
  // 2026-01-01 00:00:00 UTC → 北京 08:00:00.000
  const out = toBeijing(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  assert.equal(out, "2026-01-01 08:00:00.000");
});

test("toBeijing: 接受 ISO 字符串与 Date 实例", () => {
  assert.equal(toBeijing("2026-01-01T00:00:00Z"), "2026-01-01 08:00:00.000");
  assert.equal(toBeijing(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0))), "2026-01-01 08:00:00.000");
});

test("toBeijing: 字典序 = 时间序(便于 ORDER BY 直接用)", () => {
  const a = toBeijing(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  const b = toBeijing(Date.UTC(2026, 0, 1, 0, 0, 1, 0));
  assert.ok(a < b, `${a} 应 < ${b}`);
});

test("toBeijing: 非法输入抛错", () => {
  assert.throws(() => toBeijing("not a date"), /toBeijing: invalid/);
});

test("toBeijingCompact: YYYYMMDD-HHmmss 形态", () => {
  assert.equal(toBeijingCompact(Date.UTC(2026, 0, 1, 0, 0, 0, 0)), "20260101-080000");
});

test("toBeijingYearMonth: YYYY-MM 形态", () => {
  assert.equal(toBeijingYearMonth(Date.UTC(2026, 0, 1, 0, 0, 0, 0)), "2026-01");
  assert.equal(toBeijingYearMonth(Date.UTC(2026, 6, 15, 23, 0, 0, 0)), "2026-07");
});

test("shiftBeijing: 北京时间字符串平移 deltaMs,仍为北京时间字符串", () => {
  const base = "2026-01-01 08:00:00.000";
  assert.equal(shiftBeijing(base, 1), "2026-01-01 08:00:00.001");
  assert.equal(shiftBeijing(base, 1000), "2026-01-01 08:00:01.000");
  // 跨天
  assert.equal(shiftBeijing(base, 16 * 3600 * 1000), "2026-01-02 00:00:00.000");
});

test("shiftBeijing: 非法北京时间字符串抛错", () => {
  assert.throws(() => shiftBeijing("garbage", 1), /shiftBeijing: invalid/);
});
