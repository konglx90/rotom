import { useState } from 'react'
import type { AgentQueue, QueueItem } from './agentQueue'
import styles from './MessageQueuePanel.module.css'

interface MessageQueuePanelProps {
  queues: AgentQueue[]
  myAgentName: string
}

/**
 * 输入框上方的「消息队列」面板:展示每个被 @ 的 agent 的待处理消息
 * (处理中高亮 + 排队中带 #位次)。数据来自 deriveAgentQueues 的前端推断。
 *
 * 队列为空时返回 null —— 不占位、不挤压输入框,避免没人在排队时多出一块 UI。
 */
export function MessageQueuePanel({ queues, myAgentName }: MessageQueuePanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  if (queues.length === 0) return null

  const totalQueued = queues.reduce(
    (n, q) => n + q.items.filter(i => i.state === 'queued').length,
    0,
  )

  return (
    <div className={styles.panel}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setCollapsed(v => !v)}
        aria-expanded={!collapsed}
        title={collapsed ? '展开队列' : '收起队列'}
      >
        <span className={styles.headerIcon} aria-hidden>⏳</span>
        <span className={styles.headerTitle}>
          消息队列
          {totalQueued > 0 && <span className={styles.headerCount}> · {totalQueued} 条待处理</span>}
        </span>
        <span className={styles.chevron} aria-hidden>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className={styles.body}>
          {queues.map(q => (
            <AgentQueueSection key={q.agentName} queue={q} myAgentName={myAgentName} />
          ))}
        </div>
      )}
    </div>
  )
}

function AgentQueueSection({ queue, myAgentName }: { queue: AgentQueue; myAgentName: string }) {
  const processing = queue.items.filter(i => i.state === 'processing')
  const queued = queue.items.filter(i => i.state === 'queued')
  const status = queue.active
    ? processing.length > 0
      ? queued.length > 0
        ? `处理中 · 还有 ${queued.length} 条排队`
        : '处理中'
      : '处理中'
    : `排队 ${queued.length} 条`

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={`${styles.dot} ${queue.active ? styles.dotActive : styles.dotIdle}`} aria-hidden />
        <span className={styles.agentName}>@{queue.agentName}</span>
        <span className={styles.sectionStatus}>{status}</span>
      </div>
      <div className={styles.itemList}>
        {processing.map(item => (
          <QueueRow key={item.requestId} item={item} myAgentName={myAgentName} />
        ))}
        {queued.map(item => (
          <QueueRow key={item.requestId} item={item} myAgentName={myAgentName} />
        ))}
      </div>
    </div>
  )
}

function QueueRow({ item, myAgentName }: { item: QueueItem; myAgentName: string }) {
  const mine = item.from === myAgentName
  const isProcessing = item.state === 'processing'
  return (
    <div
      className={[
        styles.row,
        isProcessing ? styles.rowProcessing : '',
        mine ? styles.rowMine : '',
      ].join(' ')}
    >
      <span className={styles.rowBadge} aria-hidden>
        {isProcessing ? '▶' : `#${item.position ?? ''}`}
      </span>
      <span className={styles.rowSender}>{mine ? '我' : `@${item.from}`}</span>
      <span className={styles.rowContent}>{snippet(item.content)}</span>
      {isProcessing && <span className={styles.processingTag}>处理中</span>}
    </div>
  )
}

/** 剥 markdown / 结构化块标记,折叠空白,截断到纯文本摘要。 */
function snippet(content: string, maxLen = 60): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' «代码» ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' «图片» ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\][\s\S]*?(?:\[\/(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\]|$)/g, ' ')
    .replace(/[*_~>#]/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain
}
