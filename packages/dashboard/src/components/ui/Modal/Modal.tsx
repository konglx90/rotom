import type { ReactNode } from 'react'
import styles from './Modal.module.css'

interface ModalProps {
  open: boolean
  title: string
  children: ReactNode
  onClose?: () => void
  scrollable?: boolean  // 是否启用内容滚动
  footer?: ReactNode    // 固定在底部、不随内容滚动的操作区
}

export function Modal({ open, title, children, onClose, scrollable = true, footer }: ModalProps) {
  if (!open) return null
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.content} onClick={e => e.stopPropagation()}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{title}</h2>
          {onClose && (
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="关闭"
            >
              ✕
            </button>
          )}
        </div>
        {scrollable ? (
          <div className={styles.scrollContent}>{children}</div>
        ) : (
          children
        )}
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  )
}
