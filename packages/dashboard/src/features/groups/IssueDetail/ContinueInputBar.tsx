import { useEffect, useRef, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Issue } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import styles from './ContinueInputBar.module.css'

// ContinueInputBar — 常驻在 IssueDetail 底部的输入栏。根据 issue.status +
// assigned_to 切换提交通道与文案:
//   - open  + 未指派 → disabled,提示先指派 Agent
//   - open  + 已指派 → 预填 description 供编辑,按钮「开始任务」,提交走 /append
//   - in_progress    → 追加指令,按钮「追加」,提交走 /append
//   - completed/failed → 续聊,按钮「继续执行」,提交走 /continue
//   - cancelled      → 父组件不渲染本组件
interface ContinueInputBarProps {
  issueId: string
  /** 用作 continuedBy / appendedBy 字段。 */
  continuedBy: string
  status: Issue['status']
  assignedTo?: string | null
  /** open + 已指派且输入框为空时,预填此文本(通常是 issue.description)。 */
  initialPrompt?: string
  onSubmitted: () => Promise<void> | void
}

export function ContinueInputBar({
  issueId, continuedBy, status, assignedTo, initialPrompt, onSubmitted,
}: ContinueInputBarProps) {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isOpen = status === 'open'
  const isInProgress = status === 'in_progress'
  const hasAssignee = !!assignedTo
  const disabled = isOpen && !hasAssignee
  // open + 已指派 = 等待用户「开始任务」(worker 因 assigned_to 非空被 auto-claim
  // 阻断,只能由用户主动触发)。in_progress = 真正执行中,append 走队列。
  const isStartMode = isOpen && hasAssignee

  // 进入 "open + 已指派" 时把 initialPrompt 预填一次,让用户能确认/编辑后开始任务。
  // 用 ref 锁住 issueId,切换到别的 issue / 状态翻走再回来时不重复覆盖用户输入。
  const prefilledForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isStartMode) {
      prefilledForRef.current = null
      return
    }
    const key = `${issueId}:${assignedTo}`
    if (prefilledForRef.current === key) return
    prefilledForRef.current = key
    if (!prompt && initialPrompt) setPrompt(initialPrompt)
  }, [isStartMode, issueId, assignedTo, initialPrompt, prompt])

  const submit = async () => {
    const trimmed = prompt.trim()
    if (!trimmed || submitting || disabled) return
    setSubmitting(true)
    setError(null)
    try {
      if (status === 'open' || status === 'in_progress') {
        await issuesApi.append(issueId, trimmed, continuedBy)
      } else if (status === 'completed' || status === 'failed') {
        await issuesApi.continue(issueId, trimmed, continuedBy)
      } else {
        return
      }
      setPrompt('')
      await onSubmitted()
    } catch (err) {
      setError((err as Error).message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const placeholder = (() => {
    if (disabled) return '请先在上方指派 Agent，再发送指令'
    if (isStartMode) return `确认或编辑给 ${assignedTo} 的 prompt，点下方「开始任务」`
    if (isInProgress) return '追加指令给 Agent（执行中也可发送，本轮结束后自动起新一轮）…'
    if (status === 'completed') return '执行完成。补充新指令继续对话(基于上次 session)…'
    if (status === 'failed') return '上次执行失败。在这里告诉 Agent 怎么修后继续…'
    return ''
  })()

  const submitLabel = (() => {
    if (submitting) return '提交中…'
    if (isStartMode) return '开始任务'
    if (isInProgress) return '追加'
    return '继续执行'
  })()

  return (
    <div className={styles.continueInputBar}>
      <textarea
        className={styles.continueInputTextarea}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => {
          // Cmd/Ctrl + Enter 提交,与本仓库其他输入框一致。
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        disabled={submitting || disabled}
        rows={isStartMode ? 4 : 2}
      />
      <div className={styles.continueInputActions}>
        {error && <span className={styles.continueInputError}>{error}</span>}
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={submitting || disabled || !prompt.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
