import { useEffect, useState } from 'react'

// 单一事实源:给出 issue 的当前耗时(ms)。
// - 未开始(started_at 为空):返回 null(由调用方渲染「—」)
// - 已结束(completed_at 有值):固定返回区间长度,不 tick
// - 进行中:每秒 setNow 重算,组件卸载自动 clearInterval
export function useIssueElapsed(
  startedAt: string | null,
  completedAt: string | null,
): number | null {
  if (!startedAt) return null
  if (completedAt) {
    return Math.max(
      0,
      new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    )
  }
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return Math.max(0, now - new Date(startedAt).getTime())
}