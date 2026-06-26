import { useState, useCallback } from 'react'
import type { NotificationPayload } from './types'
import styles from './NotificationCard.module.css'

const ICON: Record<NotificationPayload['kind'], string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
}

const ARIA_LABEL: Record<NotificationPayload['kind'], string> = {
  success: '成功',
  error: '错误',
  warning: '警告',
  info: '信息',
}

interface Props {
  notification: NotificationPayload
  onDismiss: (id: string) => void
}

// 单张通知卡片。点击操作按钮或 × 都会自动关闭。
export function NotificationCard({ notification, onDismiss }: Props) {
  const [leaving, setLeaving] = useState(false)
  const { id, kind, title, description, actions } = notification

  // 先切换 leaving 类播退场动画,200ms 后真正从队列移除。
  const dismiss = useCallback(() => {
    setLeaving(true)
    setTimeout(() => onDismiss(id), 200)
  }, [id, onDismiss])

  const handleAction = (action: NonNullable<NotificationPayload['actions']>[number]) => {
    try {
      action.onClick()
    } finally {
      dismiss()
    }
  }

  return (
    <div
      className={`${styles.card} ${styles[kind]} ${leaving ? styles.leaving : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`${ARIA_LABEL[kind]}:${title}`}
    >
      <button
        type="button"
        className={styles.closeBtn}
        onClick={dismiss}
        aria-label="关闭通知"
      >
        ×
      </button>
      <div className={styles.row}>
        <div className={styles.icon} aria-hidden>{ICON[kind]}</div>
        <div className={styles.body}>
          <div className={styles.title}>{title}</div>
          {description && <div className={styles.description}>{description}</div>}
        </div>
      </div>
      {actions && actions.length > 0 && (
        <div className={styles.actions}>
          {actions.map((action, idx) => (
            <button
              key={idx}
              type="button"
              className={`${styles.action} ${action.primary ? styles.primary : ''}`}
              onClick={() => handleAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
