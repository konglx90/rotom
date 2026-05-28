import styles from './StatsCards.module.css'

interface StatsCardsProps {
  agents: Agent[]
}

export function StatsCards({ agents }: StatsCardsProps) {
  const onlineCount = agents.filter(a => a.status === 'online').length
  const offlineCount = agents.length - onlineCount

  const totalSent = agents.reduce((sum, a) => sum + (a.message_stats?.sent || 0), 0)
  const totalReceived = agents.reduce((sum, a) => sum + (a.message_stats?.received || 0), 0)
  const totalFailed = agents.reduce((sum, a) => sum + (a.message_stats?.failed || 0), 0)

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.value}>{agents.length}</div>
        <div className={styles.label}>总员工数</div>
      </div>

      <div className={styles.card}>
        <div className={`${styles.value} ${styles.online}`}>{onlineCount}</div>
        <div className={styles.label}>在线</div>
      </div>

      <div className={styles.card}>
        <div className={`${styles.value} ${styles.offline}`}>{offlineCount}</div>
        <div className={styles.label}>离线</div>
      </div>

      <div className={styles.card}>
        <div className={styles.value}>{totalSent}</div>
        <div className={styles.label}>总发送</div>
      </div>

      <div className={styles.card}>
        <div className={styles.value}>{totalReceived}</div>
        <div className={styles.label}>总接收</div>
      </div>

      {totalFailed > 0 && (
        <div className={styles.card}>
          <div className={`${styles.value} ${styles.error}`}>{totalFailed}</div>
          <div className={styles.label}>失败</div>
        </div>
      )}
    </div>
  )
}

import type { Agent } from '../../api/types'
