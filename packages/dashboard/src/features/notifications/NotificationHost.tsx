import { NotificationCard } from './NotificationCard'
import { useNotificationQueue, useNotificationDismiss } from './NotificationContext'
import styles from './NotificationHost.module.css'

// 顶层渲染所有可见通知卡片。挂载位置:App.tsx 的 NotificationProvider 内部、AppShell 之外,
// 避免路由切换时被 unmount 丢失通知。
export function NotificationHost() {
  const queue = useNotificationQueue()
  const dismiss = useNotificationDismiss()

  if (queue.length === 0) return null

  return (
    <div className={styles.host} aria-label="通知区域">
      {queue.map(n => (
        <NotificationCard key={n.id} notification={n} onDismiss={dismiss} />
      ))}
    </div>
  )
}
