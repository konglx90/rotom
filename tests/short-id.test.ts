/**
 * generateShortId 短 ID 生成器测试。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { generateShortId } from "../src/shared/short-id.js";

const B62 = /^[0-9A-Za-z]+$/;

describe("generateShortId", () => {
  it("默认长度 12,字符集为 base62", () => {
    for (let i = 0; i < 200; i++) {
      const id = generateShortId();
      assert.equal(id.length, 12, `len: ${id}`);
      assert.match(id, B62, `charset: ${id}`);
      // 硬约束:不含冒号(sessions.json key 分隔符)、不含 / . 等
      assert.ok(!id.includes(":"), `contains colon: ${id}`);
      assert.ok(!id.includes("/") && !id.includes("."), `bad char: ${id}`);
    }
  });

  it("自定义长度", () => {
    assert.equal(generateShortId(8).length, 8);
    assert.equal(generateShortId(21).length, 21);
    assert.equal(generateShortId(1).length, 1);
  });

  it("slice(0,8) 稳定且仍为 base62(git 派生分支后缀用)", () => {
    const id = generateShortId();
    const g8 = id.slice(0, 8);
    assert.equal(g8.length, 8);
    assert.match(g8, B62);
    assert.equal(g8, id.slice(0, 8)); // 确定性切片
  });

  it("批量生成无碰撞(熵充足)", () => {
    const set = new Set<string>();
    const N = 100_000;
    for (let i = 0; i < N; i++) set.add(generateShortId());
    assert.equal(set.size, N, "出现重复 ID");
  });

  it("字符分布大致均匀(回归用,非严格统计)", () => {
    const counts = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 50_000; i++) {
      for (const ch of generateShortId()) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
        total++;
      }
    }
    // 62 个字符都应出现;每个字符占比应在 1/62 附近(允许宽松区间)
    assert.equal(counts.size, 62, "字母表未完整覆盖");
    const avg = total / 62;
    for (const [, c] of counts) {
      // 偏差不超过均值的 20%(rejection sampling 后应远优于此)
      assert.ok(c > avg * 0.8 && c < avg * 1.2, `字符分布偏差过大: ${c} vs avg ${avg}`);
    }
  });
});
