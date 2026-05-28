import { useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Agent, Issue } from '../../../api/types'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Select } from '../../../components/ui/Select'
import styles from './IssueDetailHeader.module.css'
import type { IssueEditState } from './useIssueEdit'

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
}

type ApprovalPolicy = NonNullable<Issue['approval_policy']>

const APPROVAL_POLICY_OPTIONS: Array<{ value: ApprovalPolicy; label: string }> = [
  { value: 'r_allow', label: '读默认通过' },
  { value: 'rw_allow', label: '读写默认通过' },
]

export function IssueDetailHeader({ issue, agents, groupMembers, onBack, edit, reload, onComplete, onCancel, onDelete }: IssueDetailHeaderProps) {
  const [pendingAssignee, setPendingAssignee] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)

  const isFinalState = issue.status === 'completed' || issue.status === 'failed' || issue.status === 'cancelled'
  const isActiveState = issue.status === 'open' || issue.status === 'in_progress'
  const showAssign = issue.type !== 'collaboration'

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
          <input
            type="text"
            className={styles.issueEditTitleInput}
            value={edit.editTitle}
            onChange={e => edit.setEditTitle(e.target.value)}
            disabled={edit.savingEdit}
            autoFocus
            placeholder='标题，或以 "/plan ..." 开头进入计划模式'
          />
        ) : (
          <h4 className={styles.headerTitle} title={issue.title}>{issue.title}</h4>
        )}
        <div className={styles.headerPrimaryMeta}>
          <Badge tone="status" value={issue.status} />
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

      {edit.editing && (
        <label className={styles.editPlanRow}>
          <input
            type="checkbox"
            checked={edit.editPlanMode}
            onChange={e => edit.setEditPlanMode(e.target.checked)}
            disabled={edit.savingEdit}
          />
          <span className={styles.editPlanTag}>/plan</span>
          <span>计划模式（先输出方案，等待审批后再落盘；勾选会自动同步标题 /plan 前缀）</span>
        </label>
      )}

      {detailsVisible && (
        <div className={styles.headerSecondary}>
          {/* 元信息簇：只读 priority + id + 工作目录 */}
          <div className={styles.metaCluster}>
            <Badge tone="priority" value={issue.priority} />
            <Badge tone="id">#{issue.id.slice(0, 8)}</Badge>
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
                <Button variant="secondary" size="xs" onClick={edit.startEdit} title="编辑标题与描述">
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
