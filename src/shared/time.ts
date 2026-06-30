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

export function nowBeijing(): string {
  // Date.now() 是绝对时间戳,加 8h 后 toISOString() 把它当作 UTC 读出来——
  // 等于把真实 UTC 时间 + 8 小时,即北京时间。技巧不依赖 process.env.TZ。
  return new Date(Date.now() + BEIJING_OFFSET_MS)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  // → "2026-06-30 18:02:04.123"
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
  return new Date(d.getTime() + BEIJING_OFFSET_MS)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
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
