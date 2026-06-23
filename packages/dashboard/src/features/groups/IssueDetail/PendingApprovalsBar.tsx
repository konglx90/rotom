import { useState, lazy, Suspense } from 'react'
import { issuesApi } from '../../../api/issues'
import type { IssueEvent } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import styles from './PendingApprovalsBar.module.css'

const LazyApprovalCard = lazy(() => import('./ApprovalCard').then((m) => ({ default: m.ApprovalCard })))

// PendingApprovalsBar — sticky footer above issueActions that surfaces all
// pending approval_request events. Click Accept/Deny resolves via the same
// API that the inline ApprovalCard uses. For Deny + feedback, users still go
// to the inline card (intentionally — keeps the bar single-tap quick).
// For kind=ask the bar embeds the full ApprovalCard so the user can answer
// the question without leaving the footer.
interface PendingApprovalsBarProps {
  issueId: string
  approvals: IssueEvent[]
  onResolved: () => Promise<void> | void
}

function readMeta(ev: IssueEvent): Record<string, unknown> {
  try { return JSON.parse(ev.metadata || '{}') as Record<string, unknown> } catch { return {} }
}

export function PendingApprovalsBar({ issueId, approvals, onResolved }: PendingApprovalsBarProps) {
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

  // Bulk-accept is a write/exec convenience; "答题" 类审批不能批量按 accept,
  // 必须用户逐个选项 + 提交。
  const bulkApprovalIds = approvals
    .map(ev => {
      const m = readMeta(ev)
      if (m.kind === 'ask') return ''
      return typeof m.approvalId === 'string' ? m.approvalId : ''
    })
    .filter(Boolean)

  const acceptAll = async () => {
    if (bulkLoading || bulkApprovalIds.length < 2) return
    setBulkLoading(true)
    setBulkError(null)
    try {
      // 并行批准——多 tool 并发审批是 Claude Code hook 的典型场景。
      // 任一失败用 settled 收集，避免一个错误把已成功的也回滚。
      const results = await Promise.allSettled(
        bulkApprovalIds.map(id => issuesApi.respondApproval(issueId, id, 'accept')),
      )
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) {
        setBulkError(`${failed}/${bulkApprovalIds.length} 接受失败`)
      }
      await onResolved()
    } catch (err) {
      setBulkError((err as Error).message || 'accept-all failed')
    } finally {
      setBulkLoading(false)
    }
  }

  return (
    <div className={styles.pendingApprovalsBar}>
      <div className={styles.pendingApprovalsHeader}>
        <span>⚠️ 待确认 ({approvals.length})</span>
        {bulkApprovalIds.length >= 2 && (
          <Button
            variant="success"
            size="sm"
            disabled={bulkLoading}
            onClick={acceptAll}
          >
            {bulkLoading ? '接受中...' : `全部接受 (${bulkApprovalIds.length})`}
          </Button>
        )}
        {bulkError && <span className={styles.pendingApprovalError}>{bulkError}</span>}
      </div>
      {approvals.map(ev => {
        const meta = readMeta(ev)
        if (meta.kind === 'ask') {
          // ask 类审批走完整 ApprovalCard,避免在 bar 内维护两套问答 UI
          return (
            <Suspense key={ev.id} fallback={<div>加载中...</div>}>
              <LazyApprovalCard
                issueId={issueId}
                event={ev}
                onResolved={onResolved}
              />
            </Suspense>
          )
        }
        return (
          <PendingApprovalItem
            key={ev.id}
            issueId={issueId}
            event={ev}
            disabled={bulkLoading}
            onResolved={onResolved}
          />
        )
      })}
    </div>
  )
}

interface PendingApprovalItemProps {
  issueId: string
  event: IssueEvent
  disabled?: boolean
  onResolved: () => Promise<void> | void
}

function PendingApprovalItem({ issueId, event, disabled, onResolved }: PendingApprovalItemProps) {
  const [loading, setLoading] = useState<'accept' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const meta = readMeta(event)
  const kind = (meta.kind as 'exec' | 'file_change' | 'plan' | undefined) ?? 'exec'
  const approvalId = (meta.approvalId as string | undefined) ?? ''
  const command = meta.command as string | undefined
  const files = (meta.files as string[] | undefined) ?? []
  const plan = meta.plan as string | undefined

  const kindLabel = kind === 'exec' ? '命令' : kind === 'plan' ? '方案' : '文件'
  const summary = (() => {
    if (kind === 'exec') return command || event.content || '(无命令)'
    if (kind === 'file_change') return files.length > 0 ? files.join('、') : (event.content || '(无文件)')
    if (kind === 'plan') {
      const firstLine = (plan || '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
      return firstLine.replace(/^#+\s*/, '') || event.content || '(无方案)'
    }
    return event.content || ''
  })()

  const resolve = async (decision: 'accept' | 'deny') => {
    if (!approvalId || loading) return
    setLoading(decision)
    setError(null)
    try {
      await issuesApi.respondApproval(issueId, approvalId, decision)
      await onResolved()
    } catch (err) {
      setError((err as Error).message || `${decision} failed`)
      setLoading(null)
    }
  }

  const btnDisabled = loading !== null || disabled === true

  return (
    <div className={styles.pendingApprovalItem}>
      <span className={styles.pendingApprovalKind}>{kindLabel}</span>
      <span className={styles.pendingApprovalSummary} title={summary}>{summary}</span>
      <Button
        variant="success"
        size="sm"
        disabled={btnDisabled}
        onClick={() => resolve('accept')}
      >
        {loading === 'accept' ? '...' : 'Accept'}
      </Button>
      <Button
        variant="danger"
        outline
        size="sm"
        disabled={btnDisabled}
        onClick={() => resolve('deny')}
      >
        {loading === 'deny' ? '...' : 'Deny'}
      </Button>
      {error && <span className={styles.pendingApprovalError}>{error}</span>}
    </div>
  )
}
