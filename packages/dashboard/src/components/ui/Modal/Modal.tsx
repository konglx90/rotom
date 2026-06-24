import { useEffect, type ReactNode } from 'react'
import styles from './Modal.module.css'

export type ModalSize = 'sm' | 'md' | 'lg'

interface ModalProps {
  /** Whether the modal is visible. */
  open: boolean
  /** Headline rendered in the title bar. */
  title: string
  /** Called when the user dismisses via ✕, ESC, or backdrop click. */
  onClose?: () => void
  /** Body content. */
  children: ReactNode
  /** Wrap body in a scroll container. Default: true. */
  scrollable?: boolean
  /** Pinned footer (action area). */
  footer?: ReactNode
  /** Modal width preset. Default: 'md'. */
  size?: ModalSize
  /** Close on ESC key. Default: true. */
  closeOnEsc?: boolean
  /** Close on backdrop click. Default: true. */
  closeOnBackdrop?: boolean
}

/**
 * Shared modal/dialog primitive.
 *
 * Backwards compatibility: this component previously accepted `isOpen` and
 * `onCancel` aliases. They were dropped in favor of `open`/`onClose`; existing
 * call sites have been migrated.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  scrollable = true,
  footer,
  size = 'md',
  closeOnEsc = true,
  closeOnBackdrop = true,
}: ModalProps) {
  useEffect(() => {
    if (!open || !closeOnEsc || !onClose) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, closeOnEsc, onClose])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  const handleOverlayClick = () => {
    if (closeOnBackdrop) onClose?.()
  }

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        className={`${styles.content} ${styles[`size-${size}`] ?? ''}`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
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