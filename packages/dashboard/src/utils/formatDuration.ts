// 中文长格式:5 分 23 秒 / 1 小时 5 分 / 2 天 3 小时。
// 与现有 KanbanView.formatRelative「5 分钟前」风格一致,但用于表达
// "从 started_at 到现在/到 completed_at 的耗时",而不是"距今多久"。
export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—'
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const m = Math.floor(totalSec / 60)
  if (m < 60) return `${m} 分 ${totalSec % 60} 秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 小时`
}

// 紧凑版(本期默认不启用,留给窄列/移动端备用):m:ss 或 h:mm:ss。
export function formatDurationCompact(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}