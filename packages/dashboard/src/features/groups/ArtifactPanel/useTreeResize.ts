// 文件树宽度拖拽 hook:可拖拽分隔条调整,持久化到 localStorage。
// 深目录默认 260,用户拖宽后下次进面板保留。treeCollapsed=true 时由调用方
// 强制 0(分隔条也隐藏)。从 ArtifactPanel/index.tsx 抽出。
import { useEffect, useRef, useState } from 'react'

const TREE_WIDTH_DEFAULT = 260
const TREE_WIDTH_MIN = 180
const TREE_WIDTH_MAX = 520
const TREE_WIDTH_STORAGE_KEY = 'rotom-artifact-tree-width'

export function useTreeResize() {
  // 文件树宽度:可拖拽分隔条调整,持久化到 localStorage。深目录默认 260,
  // 用户拖宽后下次进面板保留。treeCollapsed=true 时强制 0(分隔条也隐藏)。
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(TREE_WIDTH_STORAGE_KEY)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n >= TREE_WIDTH_MIN && n <= TREE_WIDTH_MAX ? n : TREE_WIDTH_DEFAULT
    } catch {
      return TREE_WIDTH_DEFAULT
    }
  })
  const [treeDragging, setTreeDragging] = useState(false)
  const treeDragStartRef = useRef<{ x: number; w: number } | null>(null)

  useEffect(() => {
    if (!treeDragging) return
    const onMove = (e: MouseEvent) => {
      const start = treeDragStartRef.current
      if (!start) return
      // 目录树靠右:向左拖(.clientX 减小)才应让树变宽,故 delta 取反。
      const next = Math.max(
        TREE_WIDTH_MIN,
        Math.min(TREE_WIDTH_MAX, start.w - (e.clientX - start.x)),
      )
      setTreeWidth(next)
      // 同步写盘:localStorage 单 key 写很快,不必搞 debounce
      try { localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(next)) } catch { /* ignore */ }
    }
    const onUp = () => setTreeDragging(false)
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
  }, [treeDragging])

  // 双击分隔条恢复默认宽度并持久化。
  const resetTreeWidth = () => {
    setTreeWidth(TREE_WIDTH_DEFAULT)
    try { localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(TREE_WIDTH_DEFAULT)) } catch { /* ignore */ }
  }

  return { treeWidth, setTreeWidth, treeDragging, setTreeDragging, treeDragStartRef, resetTreeWidth }
}
