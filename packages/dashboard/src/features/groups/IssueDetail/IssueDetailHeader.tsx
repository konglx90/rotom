import { useEffect, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Agent, Issue } from '../../../api/types'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Select } from '../../../components/ui/Select'
import styles from './IssueDetailHeader.module.css'
import type { IssueEditState } from './useIssueEdit'
import { displayTitle } from '../createIssueTitle'
import { UsageBadge } from './UsageBadge'

interface IssueDetailHeaderProps {
  issue: Issue
  agents: Agent[]
  groupMembers: string[]
  onBack?: () => void
  edit: IssueEditState
  reload: () => Promise<void> | void
  onComplete: () => void
  onCancel: () => void
  onDelete: () => void
  /** 中断成功后触发(IssueDetail 用来清空 pendingQueue —— worker abort 时
   *  finally 块会消费队列,chip 对应的消息已被 worker 吃掉)。 */
  onInterrupted?: () => void
}

type ApprovalPolicy = NonNullable<Issue['approval_policy']>

const APPROVAL_POLICY_OPTIONS: Array<{ value: ApprovalPolicy; label: string }> = [
  { value: 'r_allow', label: '读默认通过' },
  { value: 'rw_allow', label: '读写默认通过' },
]

export function IssueDetailHeader({ issue, agents, groupMembers, onBack, edit, reload, onComplete, onCancel, onDelete, onInterrupted }: IssueDetailHeaderProps) {
  const [pendingAssignee, setPendingAssignee] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [copiedId, setCopiedId] = useState(false)
  const [interrupting, setInterrupting] = useState(false)

  const isFinalState = issue.status === 'completed' || issue.status === 'failed' || issue.status === 'cancelled'
  // active = 还能继续操作的(issue 执行 / append 续跑 / 取消 / 完成)。paused(待继续)
  // 也算 active —— session 还在,用户 append 后 worker --resume 续跑。
  const isActiveState = issue.status === 'open' || issue.status === 'in_progress' || issue.status === 'paused'
  // isInProgress 严格 = 当前正在跑 CLI。paused 不算(没在跑),所以 ESC 中断
  // 快捷键和「中断」按钮在 paused 下都不显示 —— 没有活跃步骤可中断。
  const isInProgress = issue.status === 'in_progress'
  const showAssign = issue.type !== 'collaboration'

  // 中断当前步骤(对齐 codex CLI 的 ESC):POST /issues/:id/interrupt →
  // worker abort 当前 CLI → runIssueExecution finally 块消费 pendingAppends
  // 用 --resume 续跑(队列非空)或保持 idle in_progress(队列空)。
  const handleInterrupt = async () => {
    if (interrupting) return
    setInterrupting(true)
    try {
      await issuesApi.interrupt(issue.id, issue.created_by)
      onInterrupted?.()
      await reload()
    } catch (err) {
      console.error('Failed to interrupt issue:', err)
    } finally {
      setInterrupting(false)
    }
  }

  // 全局 ESC 监听:in_progress 时触发中断(对齐 codex interaction.rs:117)。
  // 输入框 / textarea 聚焦时不拦截 —— 让用户正常 ESC 退出编辑。中断进行中
  // 不重复触发。open / 终态 ESC 无效(无活跃步骤可中断)。
  useEffect(() => {
    if (!isInProgress) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      // 输入框聚焦时 ESC 让用户退出编辑,不触发中断。
      if (tag === 'TEXTAREA' || tag === 'INPUT' || t?.isContentEditable) return
      e.preventDefault()
      void handleInterrupt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // handleInterrupt 依赖 issue.id / created_by / interrupting,但中断进行中
    // 的去重由 setInterrupting + 早 return 保证,这里不把 handleInterrupt 放
    // 依赖避免每次 render 重绑监听。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInProgress, issue.id])

  // 候选指派对象 = 群成员 ∩ 非真人 agent（真人不参与抢单执行）。
  const memberSet = new Set(groupMembers)
  const assignCandidates = agents
    .filter(a => memberSet.has(a.name) && a.profile?.category !== '真人')
    .map(a => a.name)
  // 当前指派人若不在候选列表(如已退群),仍保留以避免下拉显示为空。
  if (issue.assigned_to && !assignCandidates.includes(issue.assigned_to)) {
    assignCandidates.unshift(issue.assigned_to)
  }

  const handleAssign = async (next: string) => {
    if ((issue.assigned_to || '') === next) return
    setAssigning(true)
    try {
      await issuesApi.update(issue.id, { assignedTo: next })
      setPendingAssignee(null)
      await reload()
    } catch (err) {
      console.error('Failed to assign issue:', err)
    } finally {
      setAssigning(false)
    }
  }

  const currentPolicy: ApprovalPolicy = issue.approval_policy ?? 'r_allow'
  const handlePolicyChange = async (next: ApprovalPolicy) => {
    if (currentPolicy === next) return
    setSavingPolicy(true)
    try {
      await issuesApi.update(issue.id, { approvalPolicy: next })
      await reload()
    } catch (err) {
      console.error('Failed to update approval policy:', err)
    } finally {
      setSavingPolicy(false)
    }
  }

  // 编辑态自动展开折叠区:用户更可能想看/改这些字段(描述/操作按钮等)。
  const detailsVisible = detailsOpen || edit.editing

  return (
    <div className={styles.issueDetailHeader}>
      <div className={styles.headerPrimaryRow}>
        {onBack && (
          <Button variant="ghost" size="xs" onClick={onBack}>← 返回</Button>
        )}
        {edit.editing ? (
          <div className={styles.headerTitlePreview} title="标题由内容前 40 字符自动生成,保存时后端会更新">
            <span className={styles.headerTitlePreviewLabel}>标题预览:</span>
            <span className={styles.headerTitlePreviewText}>{edit.editTitlePreview}</span>
          </div>
        ) : (
          <h4 className={styles.headerTitle} title={displayTitle(issue)}>{displayTitle(issue)}</h4>
        )}
        <div className={styles.headerPrimaryMeta}>
          <Badge tone="status" value={issue.status} />
          <UsageBadge issue={issue} />
          {isInProgress && (
            <Button
              variant="danger"
              outline
              size="xs"
              onClick={handleInterrupt}
              disabled={interrupting}
              title="中断当前步骤(快捷键:ESC)。保留 session,队列消息会自动续跑。"
            >
              {interrupting ? '中断中…' : '■ 中断'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDetailsOpen(v => !v)}
            title={detailsOpen ? '收起更多信息' : '展开优先级 / ID / 工作目录 / 指派 / 操作'}
            disabled={edit.editing}
          >
            {detailsVisible ? '收起 ▴' : '更多 ▾'}
          </Button>
        </div>
      </div>

      {detailsVisible && (
        <div className={styles.headerSecondary}>
          {/* 元信息簇：只读 priority + id + 工作目录 */}
          <div className={styles.metaCluster}>
            <Badge tone="priority" value={issue.priority} />
            <Badge
              tone="id"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                navigator.clipboard.writeText(issue.id).then(() => {
                  setCopiedId(true)
                  setTimeout(() => setCopiedId(false), 1500)
                })
              }}
              title={copiedId ? '已复制' : `点击复制: ${issue.id}`}
            >{copiedId ? '✓ 已复制' : `#${issue.id.slice(0, 8)}`}</Badge>
            {issue.working_dir && (
              <div className={styles.issueWorkingDir} title={issue.working_dir}>
                <span className={styles.fieldLabel}>工作目录</span>
                <code className={styles.issueWorkingDirPath}>{issue.working_dir}</code>
              </div>
            )}
          </div>

          {/* 设置 + 操作：左设置簇，右操作簇 */}
          <div className={styles.controlsRow}>
            <div className={styles.settingsCluster}>
              {showAssign && (
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>指派给</label>
                  <Select
                    size="sm"
                    className={styles.inlineSelect}
                    value={pendingAssignee ?? (issue.assigned_to || '')}
                    disabled={assigning || isFinalState}
                    onChange={e => {
                      const next = e.target.value
                      setPendingAssignee(next === (issue.assigned_to || '') ? null : next)
                    }}
                  >
                    <option value="">-- 未指派 --</option>
                    {assignCandidates.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </Select>
                  {pendingAssignee !== null && !assigning && (
                    <div className={styles.inlinePending}>
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => handleAssign(pendingAssignee)}
                        disabled={isFinalState}
                      >
                        确认指派
                      </Button>
                      <Button variant="secondary" size="xs" onClick={() => setPendingAssignee(null)}>
                        取消
                      </Button>
                    </div>
                  )}
                  {assigning && <span className={styles.fieldHint}>更新中...</span>}
                  {!assigning && pendingAssignee === null && assignCandidates.length === 0 && (
                    <span className={styles.fieldHint}>群内暂无可指派的 Agent</span>
                  )}
                </div>
              )}

              {/* 审批策略：r_allow（写需审批，读放行，默认）/ rw_allow（写也自动通过）。
                  读类工具始终放行；本项只影响写类工具是否走 dashboard 人工审批。
                  终态 issue 不允许改：再改也不会触发新一次执行。 */}
              <div className={styles.fieldGroup}>
                <label
                  className={styles.fieldLabel}
                  title="读类工具始终放行；此处控制写类工具是否需要人工审批（claudecode 与 codex 共用）"
                >
                  审批策略
                </label>
                <Select
                  size="sm"
                  className={styles.inlineSelect}
                  value={currentPolicy}
                  disabled={savingPolicy || isFinalState}
                  onChange={e => { void handlePolicyChange(e.target.value as ApprovalPolicy) }}
                  options={APPROVAL_POLICY_OPTIONS}
                />
                {savingPolicy && <span className={styles.fieldHint}>保存中...</span>}
              </div>
            </div>

            <div className={styles.actionsCluster}>
              {!edit.editing && (
                <Button variant="secondary" size="xs" onClick={edit.startEdit}
                  title="编辑标题与描述">
                  编辑
                </Button>
              )}
              {isActiveState && (
                <>
                  <Button variant="success" size="xs" onClick={onComplete}>完成</Button>
                  <Button variant="danger" outline size="xs" onClick={onCancel}>取消</Button>
                </>
              )}
              {isFinalState && (
                <Button variant="secondary" size="xs" onClick={onDelete}>删除</Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
