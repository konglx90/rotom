/**
 * 全 codebase 统一的时间格式化器:北京时间字符串 "YYYY-MM-DD HH:MM:SS.mmm"。
 *
 * 设计:
 *  - 不依赖服务器时区(永远输出北京时间,无视 process.env.TZ)
 *  - 不带 Z / 时区后缀——本地时间字符串,所见即所过滤
 *  - 字典序比较 = 时间顺序比较(毫秒精度),ORDER BY 直接生效
 *  - 替代 `new Date().toISOString()`(后者返回 UTC,显示和过滤要 mental 换算,
 *    实测群消息轮询时把本地时间字符串拿去对比 UTC ISO 会 silently 滤掉)
 *
 * 用法:
 *   import { nowBeijing } from "../shared/time.js";
 *   const ts = nowBeijing();  // "2026-06-30 18:02:04.123"
 *
 * 存量数据(migration 046 之前)仍是 UTC ISO,046 会一次性转成北京时间字符串。
 */

const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** Internal: decompose a Date (or epoch ms) into Beijing-time calendar parts. */
function beijingParts(input: Date | number): {
  Y: string; M: string; D: string; h: string; m: string; s: string; ms: string;
} {
  const d = input instanceof Date ? input : new Date(input);
  const u = new Date(d.getTime() + BEIJING_OFFSET_MS);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return {
    Y: String(u.getUTCFullYear()),
    M: pad2(u.getUTCMonth() + 1),
    D: pad2(u.getUTCDate()),
    h: pad2(u.getUTCHours()),
    m: pad2(u.getUTCMinutes()),
    s: pad2(u.getUTCSeconds()),
    ms: pad3(u.getUTCMilliseconds()),
  };
}

export function nowBeijing(): string {
  return toBeijing(Date.now());
}

/**
 * 把任意时间戳(UTC ISO / Date / 毫秒数)转成北京时间字符串。
 * 用于 migration 把存量 UTC ISO 行转成新格式,或边界处把外部输入归一。
 */
export function toBeijing(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`toBeijing: invalid time input: ${input}`);
  }
  const p = beijingParts(d);
  return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s}.${p.ms}`;
}

/** Compact Beijing timestamp "YYYYMMDD-HHmmss" (e.g. for sortable upload filenames). */
export function toBeijingCompact(input: Date | number = Date.now()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`toBeijingCompact: invalid time input: ${input}`);
  }
  const p = beijingParts(d);
  return `${p.Y}${p.M}${p.D}-${p.h}${p.m}${p.s}`;
}

/** Year-month bucket "YYYY-MM" in Beijing time (used for upload directory layout). */
export function toBeijingYearMonth(input: Date | number = Date.now()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`toBeijingYearMonth: invalid time input: ${input}`);
  }
  const p = beijingParts(d);
  return `${p.Y}-${p.M}`;
}

/**
 * 把一个北京时间字符串平移 deltaMs 毫秒,返回新的北京时间字符串。
 * 用于"上一条消息后 1ms"这种 marker 计算——不依赖服务器时区。
 *
 * 注意:输入必须是北京时间字符串(不是 UTC ISO),否则解析会偏。
 */
export function shiftBeijing(beijingStr: string, deltaMs: number): string {
  // 用 +08:00 显式标注时区,让 Date.parse 把字符串当作北京时间读出绝对 instant
  const abs = Date.parse(beijingStr.replace(" ", "T") + "+08:00");
  if (Number.isNaN(abs)) {
    throw new Error(`shiftBeijing: invalid Beijing time string: ${beijingStr}`);
  }
  return toBeijing(abs + deltaMs);
}
