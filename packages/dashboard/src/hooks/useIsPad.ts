import { useEffect, useState } from 'react'

// 平板/窄屏模式触发阈值(CSS px)。OPPO Pad mini 竖屏视口通常 ≤ 900px,
// 触发 pad 模式:群聊页默认只显对话区,左右面板收起为抽屉。
// 实机若未触发(视口 CSS 像素偏大),下调此常量即可。
export const PAD_BREAKPOINT = 900

/**
 * pad 模式检测:视口宽度 ≤ breakpoint 时返回 true。
 *
 * 用途:仅群聊页(/dashboard/groups*)消费此结果做抽屉化降级,
 * 宽屏(>breakpoint)一切照旧,PC 0 影响。
 *
 * 默认纯宽度判断,保证在平板上稳定触发;若希望「PC 把窗口拉窄也不进 pad 模式」,
 * 可把 matchMedia 查询改成 `(max-width:${breakpoint}px) and (pointer:coarse)`。
 */
export function useIsPad(breakpoint: number = PAD_BREAKPOINT): boolean {
  const query = `(max-width: ${breakpoint}px)`
  const [isPad, setIsPad] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setIsPad(e.matches)
    // 挂载时同步一次,避免 SSR/初始值与当前实际状态不一致。
    setIsPad(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])

  return isPad
}
