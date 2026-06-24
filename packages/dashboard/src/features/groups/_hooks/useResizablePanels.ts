import { useCallback, useEffect, useRef, useState } from 'react'

export interface PanelConfig {
  id: string
  /** 默认宽度(px) */
  width: number
  /** 最小宽度(px),拖拽时不会低于此值 */
  min: number
}

/**
 * 水平排列 N 个可拖拽调整宽度的 panel。splitter 拖拽时:
 * 左 panel + deltaX,右 panel - deltaX,两边都受各自 min 约束
 * (左到 min 时,即使再往右拖,右也不会继续缩)。
 *
 * 拖拽样板复刻自 AppSidebar.tsx:155-175 —— dragging state + startRef +
 * window mousemove/mouseup + body.cursor/userSelect。
 *
 * - mousemove 高频 setState,不写盘;
 * - mouseup 时 dragging 翻 false,由独立 effect 一次性持久化整个 widths。
 *
 * 调用方按 visibleOrder 渲染相邻 panel + splitter,splitter 元素的
 * onMouseDown 调 onSplitterMouseDown(leftId, rightId)。
 */
export function useResizablePanels(
  storageKey: string,
  defaults: PanelConfig[],
): {
  widths: Record<string, number>
  dragging: boolean
  onSplitterMouseDown: (leftId: string, rightId: string) => (e: React.MouseEvent) => void
  reset: () => void
} {
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults

  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const fallback: Record<string, number> = {}
    for (const c of defaults) fallback[c.id] = c.width
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return fallback
      const parsed = JSON.parse(raw) as { widths?: Record<string, number> }
      if (!parsed.widths) return fallback
      const result: Record<string, number> = {}
      for (const c of defaults) {
        const stored = parsed.widths[c.id]
        result[c.id] = typeof stored === 'number' && stored >= c.min ? stored : c.width
      }
      return result
    } catch {
      return fallback
    }
  })
  const [dragging, setDragging] = useState(false)
  // startRef:拖拽起点 {x, leftId, rightId, 两边初始宽度}。ref 而非 state,
  // 避免 mousemove 回调闭包读到 stale 值。
  const startRef = useRef<{
    x: number
    leftId: string
    rightId: string
    leftWidth: number
    rightWidth: number
  } | null>(null)

  useEffect(() => {
    if (!dragging) return
    const config = defaultsRef.current
    const minOf = (id: string) => config.find(c => c.id === id)?.min ?? 0
    const onMove = (e: MouseEvent) => {
      const start = startRef.current
      if (!start) return
      const delta = e.clientX - start.x
      const minLeft = minOf(start.leftId)
      const minRight = minOf(start.rightId)
      // 左 panel 新宽度同时受「自身 min」和「右 panel 不能低于 min」约束。
      // 上界 = start.leftWidth + start.rightWidth - minRight(把右 panel 顶到 min)
      // 下界 = minLeft
      const upper = start.leftWidth + start.rightWidth - minRight
      const newLeft = Math.max(minLeft, Math.min(upper, start.leftWidth + delta))
      const actualDelta = newLeft - start.leftWidth
      const newRight = start.rightWidth - actualDelta
      setWidths(prev => ({ ...prev, [start.leftId]: newLeft, [start.rightId]: newRight }))
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging])

  // dragging 从 true→false 时写盘一次。mousemove 期间不写,避免高频 IO。
  useEffect(() => {
    if (dragging) return
    try {
      localStorage.setItem(storageKey, JSON.stringify({ widths }))
    } catch {
      /* ignore */
    }
  }, [dragging, widths, storageKey])

  const onSplitterMouseDown = useCallback(
    (leftId: string, rightId: string) => (e: React.MouseEvent) => {
      e.preventDefault()
      startRef.current = {
        x: e.clientX,
        leftId,
        rightId,
        leftWidth: widths[leftId],
        rightWidth: widths[rightId],
      }
      setDragging(true)
    },
    [widths],
  )

  const reset = useCallback(() => {
    const fallback: Record<string, number> = {}
    for (const c of defaultsRef.current) fallback[c.id] = c.width
    setWidths(fallback)
  }, [])

  return { widths, dragging, onSplitterMouseDown, reset }
}
