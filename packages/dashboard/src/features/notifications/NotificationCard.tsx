import { useState, useCallback } from 'react'
import type { NotificationPayload } from './types'
import styles from './NotificationCard.module.css'

// vite base 是 /dashboard/,public 资源必须带前缀。用 BASE_URL 自适应 dev/build。
const ANIM = `${import.meta.env.BASE_URL}animations/`

// 每种类型对应一只 calico 猫的动画,语义对齐:
// success=happy / error=error / warning=notification / info=thinking。
const SPRITE: Record<NotificationPayload['kind'], string> = {
  success: `${ANIM}calico-happy.apng`,
  error: `${ANIM}calico-error.apng`,
  warning: `${ANIM}calico-notification.apng`,
  info: `${ANIM}calico-thinking.apng`,
}

const SPRITE_ALT: Record<NotificationPayload['kind'], string> = {
  success: '开心的猫',
  error: '出错的猫',
  warning: '警觉的猫',
  info: '思考的猫',
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
      <img
        className={styles.sprite}
        src={SPRITE[kind]}
        alt={SPRITE_ALT[kind]}
        aria-hidden
      />
      <div className={styles.body}>
        <div className={styles.title}>{title}</div>
        {description && <div className={styles.description}>{description}</div>}
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
