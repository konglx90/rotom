import type { ReactNode } from 'react'
import styles from './Badge.module.css'

export type BadgeTone = 'status' | 'priority' | 'category' | 'source' | 'id' | 'tag'

interface BadgeProps {
  tone: BadgeTone
  /** 业务 enum 值；组件内部按 tone+value lookup 颜色和默认文案 */
  value?: string
  /** 显式覆盖显示文案；id/tag 这类总是用 children */
  children?: ReactNode
  className?: string
  title?: string
}

// ── 颜色/文案映射 ────────────────────────────────────────────────────
// 颜色直接 1:1 来源于历史 CSS（IssueDetailHeader / IssuePanel / MessagesView /
// ChatArea / AgentList），不要顺手「调和谐」。

const STATUS_COLORS: Record<string, string> = {
  // Issue 维度
  open: 'blue',
  in_progress: 'amber',
  completed: 'green',
  failed: 'red',
  cancelled: 'slate',
  // Message 维度
  ok: 'green',
  routed: 'green',
  delivered: 'green',
  queued: 'amber',
  no_target: 'red',
  group_message: 'slate',
}

const STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  in_progress: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'slate',
  medium: 'blue',
  high: 'orange',
  critical: 'red',
}

const CATEGORY_COLORS: Record<string, string> = {
  '快交付组': 'amber',
  '稳交付组': 'blue',
  '真人': 'green',
  'system': 'slate',
  // 兼容英文 key
  fast: 'amber',
  stable: 'blue',
  human: 'green',
}

const SOURCE_COLORS: Record<string, string> = {
  cli: 'purple',
  ws: 'blue',
  api: 'pink',
  webhook: 'amber',
}

function pickColor(tone: BadgeTone, value?: string): string {
  if (!value) {
    if (tone === 'id') return 'purple'
    if (tone === 'tag') return 'slate'
    return 'slate'
  }
  switch (tone) {
    case 'status': return STATUS_COLORS[value] || 'slate'
    case 'priority': return PRIORITY_COLORS[value] || 'slate'
    case 'category': return CATEGORY_COLORS[value] || 'slate'
    case 'source': return SOURCE_COLORS[value] || 'slate'
    case 'id': return 'purple'
    case 'tag': return 'slate'
  }
}

export function Badge({ tone, value, children, className = '', title }: BadgeProps) {
  const color = pickColor(tone, value)
  const display = children !== undefined
    ? children
    : (tone === 'status' && value ? (STATUS_LABELS[value] || value) : value)

  const classes = [
    styles.badge,
    styles[`tone_${tone}`],
    styles[`color_${color}`],
    className,
  ].filter(Boolean).join(' ')

  return <span className={classes} title={title}>{display}</span>
}
