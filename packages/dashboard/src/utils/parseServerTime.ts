// 把后端时间字符串(或 Date / epoch ms)解析成 epoch 毫秒。
//
// 背景:Master 的 SQLite 把所有时间戳都用 nowBeijing() 写成北京时间字符串,
// 形如 "2026-07-08 18:02:04.123",**不带时区后缀**(见 src/shared/time.ts)。
// 旧代码里前端有两种解析方式,都是错的:
//   1. `new Date(str)` —— 把字符串当**浏览器本地时区**解析,UTC 机器上偏 8h;
//   2. `str + 'Z'` —— 把字符串当 **UTC** 解析,然后 `toLocaleString({timeZone:
//      'Asia/Shanghai'})` 再加 8h,显示比真实时间快 8h(Issue 详情页时间偏差的根因)。
//
// 正确做法:不带 Z / ±HH:MM 后缀的字符串视为北京时间(append "+08:00")。
// 带 Z 或偏移的字符串(理论上 master 不会发,但兜底)直接按其字面时区解析。
//
// 用法:
//   import { parseServerTime } from '../utils/parseServerTime'
//   const ts = parseServerTime(issue.created_at)
//   if (ts == null) return '—'
//   new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ... })

export function parseServerTime(input: string | number | Date | null | undefined): number | null {
  if (input == null) return null
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (input instanceof Date) {
    const t = input.getTime()
    return Number.isNaN(t) ? null : t
  }
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!s) return null
  // 已带时区后缀 → 按字面解析。覆盖 'Z' / '+08:00' / '-05:00' 三类。
  // 用正则而非 includes('+'):'2026-07-08 18:02:04.123' 里没有 '+',但
  // ISO '2026-07-08T18:02:04+08:00' 末尾的 '+08:00' 需要识别。
  if (s.endsWith('Z') || s.endsWith('z') || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? null : t
  }
  // 不带时区:视为北京时间。把空格分隔的 'YYYY-MM-DD HH:MM:SS.mmm' 规整成
  // ISO 'YYYY-MM-DDTHH:MM:SS.mmm' 再 append '+08:00',Date.parse 才能正确读取。
  // 直接对 'YYYY-MM-DD HH:MM:SS.mmm+08:00' 解析在 Safari 等引擎上不可靠。
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  const t = Date.parse(`${iso}+08:00`)
  return Number.isNaN(t) ? null : t
}
