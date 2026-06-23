import { useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { issuesApi } from '../../../api/issues'
import type { IssueEvent } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import { useMonaco } from '../../../hooks/useMonaco'
import styles from './ApprovalCard.module.css'
import { APPROVAL_STATUS_LABEL, detectLanguage, type DiffData } from './utils'

interface ApprovalCardProps {
  event: IssueEvent
  issueId: string
  onResolved: () => Promise<void> | void
}

interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: Array<{ label: string; description: string }>
}

const OTHER_OPTION_LABEL = '其他'

// Inline approval card. Codex pauses on its JSON-RPC request until the user
// clicks one of the buttons; the master pushes the decision back over the
// worker WebSocket. `pending` is the only state where buttons render — once
// resolved the card collapses to a status badge so the timeline keeps reading
// chronologically.
export function ApprovalCard({ event, issueId, onResolved }: ApprovalCardProps) {
  const [loading, setLoading] = useState<'accept' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Two-stage deny: clicking Deny first opens a feedback textarea, then a
  // second click on "确认拒绝" actually submits. Feedback is optional — empty
  // submissions fall back to the legacy generic reason.
  const [denyStage, setDenyStage] = useState<'idle' | 'composing'>('idle')
  const [denyFeedback, setDenyFeedback] = useState('')
  const { ready: monacoReady } = useMonaco()

  const meta = (() => {
    try { return JSON.parse(event.metadata || '{}') as Record<string, unknown> } catch { return {} }
  })()
  const kind = (meta.kind as 'exec' | 'file_change' | 'plan' | 'ask' | undefined) ?? 'exec'
  const status = (meta.status as string | undefined) ?? 'pending'
  // ask 类型走 deny+feedback 通道回传答案,后端持久化的 status 是 'denied',
  // 但 UI 不应该展示成"已拒绝"+红色——对用户而言是"已答复"。这里把展示态翻成
  // 'answered',底层数据不动。
  const displayStatus = kind === 'ask' && status === 'denied' ? 'answered' : status
  const approvalId = (meta.approvalId as string | undefined) ?? ''
  const command = meta.command as string | undefined
  const cwd = meta.cwd as string | undefined
  const files = (meta.files as string[] | undefined) ?? []
  const plan = meta.plan as string | undefined
  const resolvedBy = meta.resolvedBy as string | undefined
  const feedback = meta.feedback as string | undefined
  const diff = meta.diff as DiffData | undefined
  const questions = (meta.questions as AskQuestion[] | undefined) ?? []

  // For kind=ask the user picks answers from radio/checkbox lists rather than
  // accept/deny. State shape: per-question array of selected option labels +
  // optional free-text when "其他" is chosen.
  const [askAnswers, setAskAnswers] = useState<Record<number, { choices: string[]; otherText: string }>>({})
  const [askSubmitting, setAskSubmitting] = useState(false)

  const headerLabel =
    kind === 'exec' ? '⚠️ 请求执行命令'
    : kind === 'plan' ? '📋 请求确认方案'
    : kind === 'ask' ? '❓ 请求询问用户'
    : '⚠️ 请求修改文件'
  const isPending = status === 'pending'

  const resolve = async (decision: 'accept' | 'deny', feedbackText?: string) => {
    if (!approvalId || loading) return
    setLoading(decision)
    setError(null)
    try {
      await issuesApi.respondApproval(issueId, approvalId, decision, undefined, feedbackText)
      await onResolved()
    } catch (err) {
      setError((err as Error).message || `${decision} failed`)
    } finally {
      setLoading(null)
    }
  }

  const toggleAskChoice = (qIdx: number, multi: boolean, label: string) => {
    setAskAnswers((prev) => {
      const cur = prev[qIdx] ?? { choices: [], otherText: '' }
      const hasIt = cur.choices.includes(label)
      const nextChoices = multi
        ? (hasIt ? cur.choices.filter((c) => c !== label) : [...cur.choices, label])
        : [label]
      return { ...prev, [qIdx]: { ...cur, choices: nextChoices } }
    })
  }

  const setAskOtherText = (qIdx: number, text: string) => {
    setAskAnswers((prev) => {
      const cur = prev[qIdx] ?? { choices: [], otherText: '' }
      return { ...prev, [qIdx]: { ...cur, otherText: text } }
    })
  }

  const formatAskAnswers = (): string => {
    return questions.map((q, idx) => {
      const ans = askAnswers[idx] ?? { choices: [], otherText: '' }
      const labelParts = ans.choices.length > 0 ? ans.choices.join('、') : '(未选)'
      const otherLine = ans.choices.includes(OTHER_OPTION_LABEL) && ans.otherText.trim()
        ? `\n   补充：${ans.otherText.trim()}`
        : ''
      const headerPrefix = q.header ? `[${q.header}] ` : ''
      return `Q${idx + 1} ${headerPrefix}${q.question}\n→ ${labelParts}${otherLine}`
    }).join('\n\n')
  }

  const askReady = questions.length > 0 && questions.every((_q, idx) => {
    const ans = askAnswers[idx]
    if (!ans || ans.choices.length === 0) return false
    if (ans.choices.includes(OTHER_OPTION_LABEL) && !ans.otherText.trim()) return false
    return true
  })

  const submitAsk = async () => {
    if (!approvalId || askSubmitting || !askReady) return
    setAskSubmitting(true)
    setError(null)
    try {
      // AskUserQuestion 的答复通过 deny + feedback 通道回传，executor 端识别
      // kind=ask 后把 feedback 整段作为 permissionDecisionReason 给 Claude 看。
      await issuesApi.respondApproval(issueId, approvalId, 'deny', undefined, formatAskAnswers())
      await onResolved()
    } catch (err) {
      setError((err as Error).message || 'submit failed')
    } finally {
      setAskSubmitting(false)
    }
  }

  return (
    <div className={`${styles.approvalCard} ${styles[`approval_${displayStatus}`] || ''}`}>
      <div className={styles.approvalHeader}>
        <span className={styles.approvalTitle}>{headerLabel}</span>
        <span className={`${styles.approvalStatus} ${styles[`approvalStatus_${displayStatus}`] || ''}`}>
          {APPROVAL_STATUS_LABEL[displayStatus] || displayStatus}
        </span>
      </div>
      {kind === 'exec' && command && (
        <pre className={styles.approvalBody}>{command}</pre>
      )}
      {kind === 'file_change' && files.length > 0 && (
        <>
          <ul className={styles.approvalFileList}>
            {files.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
          {diff && diff.hunks.length > 0 && diff.hunks.map((hunk, i) => (
            <div key={i} className={styles.diffSection}>
              {diff.hunks.length > 1 && (
                <div className={styles.diffHunkLabel}>Edit {i + 1}</div>
              )}
              <div className={styles.diffEditorWrap}>
                {monacoReady ? (
                  <DiffEditor
                    height={Math.min(Math.max(hunk.old_string.split('\n').length, hunk.new_string.split('\n').length) * 18 + 40, 300)}
                    language={files[0] ? detectLanguage(files[0]) : 'plaintext'}
                    original={hunk.old_string}
                    modified={hunk.new_string}
                    theme="vs"
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 11,
                      renderSideBySide: true,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      wordWrap: 'on',
                      lineNumbers: 'on',
                    }}
                  />
                ) : (
                  <div className={styles.diffEditorWrap} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)', fontSize: 12 }}>编辑器加载中...</div>
                )}
              </div>
            </div>
          ))}
          {diff && diff.new_content && (
            <div className={styles.diffSection}>
              <div className={styles.diffWriteLabel}>
                写入新内容{diff.truncated ? ' (已截断)' : ''}
              </div>
              <pre className={styles.approvalBody}>{diff.new_content.length > 5000
                ? diff.new_content.slice(0, 5000) + '\n... (内容过长，已截断显示)'
                : diff.new_content
              }</pre>
            </div>
          )}
          {diff?.truncated && !diff.new_content && (
            <div className={styles.diffTruncatedNote}>差异内容过长，已截断</div>
          )}
        </>
      )}
      {kind === 'plan' && plan && (
        <div className={styles.approvalBody}>
          <MarkdownContent content={plan} />
        </div>
      )}
      {kind === 'ask' && questions.length > 0 && (
        <>
          {questions.map((q, qIdx) => {
            const ans = askAnswers[qIdx] ?? { choices: [], otherText: '' }
            const optionsWithOther = [...q.options, { label: OTHER_OPTION_LABEL, description: '自由输入' }]
            return (
              <div key={qIdx} className={styles.askQuestionBlock}>
                {q.header && <div className={styles.askQuestionHeader}>{q.header}</div>}
                <div className={styles.askQuestionTitle}>{q.question}</div>
                <div className={styles.askOptionList}>
                  {optionsWithOther.map((opt, oIdx) => {
                    const checked = ans.choices.includes(opt.label)
                    return (
                      <label key={oIdx} className={styles.askOption}>
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`ask-${event.id}-${qIdx}`}
                          checked={checked}
                          disabled={!isPending || askSubmitting}
                          onChange={() => toggleAskChoice(qIdx, q.multiSelect, opt.label)}
                        />
                        <span>
                          <span className={styles.askOptionLabel}>{opt.label}</span>
                          {opt.description && (
                            <span className={styles.askOptionDesc}>{opt.description}</span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                </div>
                {ans.choices.includes(OTHER_OPTION_LABEL) && (
                  <input
                    className={styles.askOtherInput}
                    type="text"
                    placeholder="请输入"
                    value={ans.otherText}
                    disabled={!isPending || askSubmitting}
                    onChange={(e) => setAskOtherText(qIdx, e.target.value)}
                  />
                )}
              </div>
            )
          })}
          {!isPending && feedback && (
            <div className={styles.askAnswerPreview}>
              <div className={styles.askAnswerLabel}>用户答复</div>
              {feedback}
            </div>
          )}
        </>
      )}
      {kind === 'exec' && cwd && (
        <div className={styles.approvalMeta}>cwd: {cwd}</div>
      )}
      {!isPending && resolvedBy && (
        <div className={styles.approvalMeta}>由 {resolvedBy} 处理</div>
      )}
      {!isPending && kind !== 'ask' && feedback && (
        <div className={styles.approvalMeta}>拒绝原因：{feedback}</div>
      )}
      {error && <div className={styles.approvalError}>{error}</div>}
      {isPending && kind !== 'ask' && denyStage === 'composing' && (
        <textarea
          className={styles.approvalFeedback}
          placeholder="补充拒绝原因（可选，会回传给 Agent）"
          value={denyFeedback}
          onChange={(e) => setDenyFeedback(e.target.value)}
          disabled={loading !== null}
          autoFocus
        />
      )}
      {isPending && kind === 'ask' && (
        <div className={styles.approvalActions}>
          <Button
            variant="primary"
            size="sm"
            disabled={!askReady || askSubmitting}
            onClick={submitAsk}
          >
            {askSubmitting ? '提交中…' : '提交答复'}
          </Button>
        </div>
      )}
      {isPending && kind !== 'ask' && denyStage === 'idle' && (
        <div className={styles.approvalActions}>
          <Button
            variant="success"
            size="sm"
            disabled={loading !== null}
            onClick={() => resolve('accept')}
          >
            {loading === 'accept' ? '处理中…' : 'Accept'}
          </Button>
          <Button
            variant="danger"
            outline
            size="sm"
            disabled={loading !== null}
            onClick={() => setDenyStage('composing')}
          >
            Deny
          </Button>
        </div>
      )}
      {isPending && kind !== 'ask' && denyStage === 'composing' && (
        <div className={styles.approvalActions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading !== null}
            onClick={() => { setDenyStage('idle'); setDenyFeedback('') }}
          >
            取消
          </Button>
          <Button
            variant="danger"
            outline
            size="sm"
            disabled={loading !== null}
            onClick={() => resolve('deny', denyFeedback)}
          >
            {loading === 'deny' ? '处理中…' : '确认拒绝'}
          </Button>
        </div>
      )}
    </div>
  )
}
