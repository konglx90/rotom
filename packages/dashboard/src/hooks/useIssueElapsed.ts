import { useEffect, useState } from 'react'
import { parseServerTime } from '../utils/parseServerTime'

// 单一事实源:给出 issue 的当前耗时(ms)。
// - 未开始(started_at 为空):返回 null(由调用方渲染「—」)
// - 已结束(completed_at 有值):固定返回区间长度,不 tick
// - 进行中:每秒 setNow 重算,组件卸载自动 clearInterval
//
// hooks 必须无条件调用:startedAt/completedAt 在 issue 生命周期里会从空变非空
// (open → in_progress 时 worker 写入 started_at),早期版本在 hooks 之前 early
// return 会导致 IssueDetailHeader 的 hook 序列在跨状态时变形,触发 React
// "Rendered fewer hooks than expected" 报错。timer 的启停收到 effect 内部按
// startedAt/completedAt 判断,effect 依赖这两个值即可正确启停。
//
// 时间解析走 parseServerTime:master 把 started_at / completed_at 写成不带
// 时区后缀的北京时间字符串,直接 `new Date(str)` 会被当本地时区解析,在非
// UTC+8 机器上耗时算错(跨时区机器差 8h)。统一在这里归一。
export function useIssueElapsed(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt || completedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt, completedAt])

  const startedTs = parseServerTime(startedAt)
  if (startedTs == null) return null
  if (completedAt) {
    const completedTs = parseServerTime(completedAt)
    if (completedTs == null) return null
    return Math.max(0, completedTs - startedTs)
  }
  return Math.max(0, now - startedTs)
}
