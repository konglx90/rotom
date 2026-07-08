import { useEffect, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Agent, Issue } from '../../../api/types'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Select } from '../../../components/ui/Select'
import { useIsPad } from '../../../hooks/useIsPad'
import styles from './IssueDetailHeader.module.css'
import type { IssueEditState } from './useIssueEdit'
import { displayTitle } from '../createIssueTitle'

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
  /** 触发中断 —— 由 IssueDetailBody 实现:flush pendingQueue + textarea 草稿,
   *  再 POST /interrupt。flush 在父组件做是为了让 textarea 草稿(chip 入队
   *  前的纯文本)也能被一并发出,对齐 placeholder 承诺的「Esc 统一发送并中断」。 */
  onInterrupt: () => void
  /** 中断进行中标记(父组件维护,去重按钮和快捷键)。 */
  interrupting: boolean
  /** 访客模式:隐藏中断、完成、取消、删除、指派、编辑、approval_policy 等按钮。 */
  readOnly?: boolean
}

type ApprovalPolicy = NonNullable<Issue['approval_policy']>

const APPROVAL_POLICY_OPTIONS: Array<{ value: ApprovalPolicy; label: string }> = [
  { value: 'rw_allow', label: '读写默认通过' },
  { value: 'r_allow', label: '读默认通过' },
]

export function IssueDetailHeader({ issue, agents, groupMembers, onBack, edit, reload, onComplete, onCancel, onDelete, onInterrupt, interrupting, readOnly = false }: IssueDetailHeaderProps) {
  const [pendingAssignee, setPendingAssignee] = useState<string | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [copiedId, setCopiedId] = useState(false)
  const [copiedSession, setCopiedSession] = useState(false)
  // Pad 上没物理 ESC:中断入口靠这个按钮本身(不再依赖快捷键),所以按钮
  // 要更显眼(size sm 而非 xs,触屏好按)+ title 去掉 ESC 文案。
  // 对齐 issue #f291053d 的 Pad 适配。
  const isPad = useIsPad()

  const isFinalState = issue.status === 'completed' || issue.status === 'failed' || issue.status === 'cancelled'
  // active = 还能继续操作的(issue 执行 / append 续跑 / 取消 / 完成)。paused(待继续)
  // 也算 active —— session 还在,用户 append 后 worker --resume 续跑。
  const isActiveState = issue.status === 'open' || issue.status === 'in_progress' || issue.status === 'paused'
  // isInProgress 严格 = 当前正在跑 CLI。paused 不算(没在跑),所以 ESC 中断
  // 快捷键和「中断」按钮在 paused 下都不显示 —— 没有活跃步骤可中断。
  const isInProgress = issue.status === 'in_progress'

  // 全局 ESC 监听(对齐 codex CLI 的 ESC + flush steers 与编辑取消):
  //   - 编辑态(edit.editing):取消编辑,退出 textarea,不触发中断。
  //   - in_progress:调父组件的 onInterrupt —— flush pendingQueue + textarea
  //     草稿 + POST /interrupt,worker abort + finally 块用 --resume 续跑。
  //     即使 ContinueInputBar textarea 聚焦也触发:placeholder 已告知用户
  //     「Esc 统一发送并中断当前步骤」,且父组件会把 textarea 当前文本一并
  //     flush,避免「裸中断」丢用户输入。
  //   - open / paused / 终态且未编辑:无 ESC 行为(没活跃步骤可中断,也没编辑可取消)。
  // 旧实现 `if (!isInProgress) return` 让 listener 只在 in_progress 挂载,
  // 结果非 in_progress 态下编辑描述时 ESC 完全无反应(早期 issue 修复点)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (edit.editing) {
        e.preventDefault()
        edit.cancelEdit()
        return
      }
      if (!isInProgress) return
      e.preventDefault()
      onInterrupt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // onInterrupt 是父组件 useCallback,依赖 issue.id/created_by/reload,
    // 稳定性足够。edit.editing / isInProgress 必须放依赖:进入/退出编辑或
    // 状态翻进/翻出 in_progress 时重绑 listener,确保 ESC 走对应分支。
  }, [edit.editing, isInProgress, onInterrupt])

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

  const currentPolicy: ApprovalPolicy = issue.approval_policy ?? 'rw_allow'
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
          {!readOnly && isInProgress && (
            <Button
              variant="danger"
              outline
              size={isPad ? 'sm' : 'xs'}
              onClick={onInterrupt}
              disabled={interrupting}
              title={isPad
                ? '中断当前步骤。保留 session,队列消息与输入框草稿会一并 flush 给 worker 续跑。'
                : '中断当前步骤(快捷键:ESC)。保留 session,队列消息与输入框草稿会一并 flush 给 worker 续跑。'}
            >
              {interrupting ? '中断中…' : '■ 中断'}
            </Button>
          )}
          {!readOnly && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setDetailsOpen(v => !v)}
              title={detailsOpen ? '收起更多信息' : '展开优先级 / ID / 工作目录 / 指派 / 操作'}
              disabled={edit.editing}
            >
              {detailsVisible ? '收起 ▴' : '更多 ▾'}
            </Button>
          )}
        </div>
      </div>

      {detailsVisible && (
        <div className={styles.headerSecondary}>
          {/* 元信息簇：只读 priority + id + 工作目录 + session(耗时 / token
              usage 已挪到底部 IssueStatusBar,贴着输入框更直观) */}
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
            {issue.session_id && (
              <div
                className={styles.issueWorkingDir}
                title={`该 issue 执行时绑定的 ${issue.cli_tool ?? '?'} session:\n${issue.session_id}\n注意:issue session 与 Debug Sessions 视图里的 chat session 是两个独立 session。点击复制。`}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  // 外层 {issue.session_id && (...)} 已保证 session_id 非空,
                  // 但 TS 不会跨闭包收窄 prop 的可选属性,这里用 ! 显式断言。
                  navigator.clipboard.writeText(issue.session_id!).then(() => {
                    setCopiedSession(true)
                    setTimeout(() => setCopiedSession(false), 1500)
                  }).catch(() => { /* ignore */ })
                }}
              >
                <span className={styles.fieldLabel}>{issue.cli_tool ?? 'session'}</span>
                <code className={styles.issueWorkingDirPath}>
                  {copiedSession ? '✓ 已复制' : issue.session_id}
                </code>
              </div>
            )}
          </div>

          {/* 设置 + 操作：左设置簇，右操作簇。访客模式只展示元信息,所有写操作隐藏。 */}
          {!readOnly && (
          <div className={styles.controlsRow}>
            <div className={styles.settingsCluster}>
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

              {/* 审批策略：rw_allow（写自动通过，读自动通过，默认）/ r_allow（写需审批，读放行）。
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
              {issue.status === 'completed' && (
                <ExtractMemoryButton issueId={issue.id} agentName={issue.assigned_to ?? undefined} />
              )}
            </div>
          </div>
          )}
        </div>
      )}
    </div>
  )
}

function ExtractMemoryButton({ issueId, agentName }: { issueId: string; agentName?: string }) {
  const [extracting, setExtracting] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const handleExtract = async () => {
    if (extracting) return
    if (!window.confirm('生成记忆?会创建一个提取任务 Issue,push 给原 Issue 的 assignee 执行。提取出的记忆进入「待审核」,需在 Memory 面板审核。')) return
    setExtracting(true)
    setMsg(null)
    try {
      const r = await issuesApi.extractMemory(issueId, agentName)
      setMsg(r.pushed ? `已派给 ${r.agentName}` : `已建任务,但 ${r.agentName} 离线,上线后自动抢单`)
    } catch (e) {
      setMsg(`失败:${(e as Error).message}`)
    } finally {
      setExtracting(false)
    }
  }

  return (
    <>
      <Button variant="secondary" size="xs" onClick={handleExtract} disabled={extracting} title="从本次 Issue 产出提炼记忆,写入待审核池">
        {extracting ? '生成中...' : '🧠 生成记忆'}
      </Button>
      {msg && <span className={styles.fieldHint}>{msg}</span>}
    </>
  )
}
