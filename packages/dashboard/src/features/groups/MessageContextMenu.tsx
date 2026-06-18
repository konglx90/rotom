import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from './types'
import styles from './ChatArea.module.css'

interface MessageContextMenuProps {
  x: number
  y: number
  msg: ChatMessage
  onQuote: (msg: ChatMessage) => void
  onCopy: (msg: ChatMessage, plain: boolean) => void
  onShowPrompt?: (msg: ChatMessage) => void
  onClose: () => void
}

// 右键消息气泡时弹出的浮动菜单。fixed 定位贴在右键坐标,自动避免溢出
// 视口右下边界。Esc / 外部点击 / 窗口 scroll / resize 任一发生都关闭。
export function MessageContextMenu({
  x, y, msg, onQuote, onCopy, onShowPrompt, onClose,
}: MessageContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  // 测量实际尺寸,若溢出右/下边界则翻向左/上。必须在 paint 前同步完成,
  // 否则会出现一帧的溢出闪动。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    let left = x
    let top = y
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin)
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin)
    }
    setPos({ left, top })
  }, [x, y])

  // 关闭触发器:外部 mousedown / Esc / 窗口 resize / 滚动(任何元素)。
  // scroll 用 capture 是因为 messagesArea 自身可滚动,且不想被中间元素 stopPropagation。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onResizeOrScroll = () => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResizeOrScroll)
    window.addEventListener('scroll', onResizeOrScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResizeOrScroll)
      window.removeEventListener('scroll', onResizeOrScroll, true)
    }
  }, [onClose])

  const hasPrompt = Boolean(msg.composedPrompt)

  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <div
      ref={ref}
      className={styles.contextMenu}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
    >
      <div
        className={styles.contextMenuItem}
        role="menuitem"
        onClick={run(() => onQuote(msg))}
      >
        💬 引用
      </div>
      <div className={styles.contextMenuSeparator} />
      <div
        className={styles.contextMenuItem}
        role="menuitem"
        onClick={run(() => onCopy(msg, false))}
      >
        📋 复制
      </div>
      <div
        className={styles.contextMenuItem}
        role="menuitem"
        onClick={run(() => onCopy(msg, true))}
      >
        📝 复制纯文本
      </div>
      {hasPrompt && onShowPrompt && (
        <>
          <div className={styles.contextMenuSeparator} />
          <div
            className={styles.contextMenuItem}
            role="menuitem"
            onClick={run(() => onShowPrompt(msg))}
          >
            🔍 查看 prompt
          </div>
        </>
      )}
    </div>
  )
}
