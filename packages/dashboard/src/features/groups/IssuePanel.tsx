import { useState } from 'react'
import type { Agent, Issue } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { useIssueElapsed } from '../../hooks/useIssueElapsed'
import { formatDuration } from '../../utils/formatDuration'
import { IssueDetail } from './IssueDetail'
import { CreateIssueDialog } from './CreateIssueDialog'
import { resolveAssigneeName, UNCLAIMED_LABEL } from './agentDisplayName'
import styles from './IssuePanel.module.css'
import { displayTitle } from './createIssueTitle'

// 单行渲染成子组件:useIssueElapsed 内部有 setInterval,必须在每行内
// 各自调用,否则 1s tick 会让整个列表重渲染(其它行 idle 但都被刷)。
function IssueListItem({
  issue,
  agents,
  selectedIssueId,
  onSelect,
}: {
  issue: Issue
  agents: Agent[]
  selectedIssueId: string
  onSelect: () => void
}) {
  const assignee = resolveAssigneeName(issue.assigned_to, agents)
  const elapsedMs = useIssueElapsed(issue.started_at, issue.completed_at)
  const isFinal = issue.status === 'completed' || issue.status === 'failed' || issue.status === 'cancelled'
  const elapsedClass = isFinal
    ? styles.issueElapsedDone
    : issue.status === 'in_progress'
      ? styles.issueElapsedRunning
      : styles.issueElapsedIdle
  const elapsedIcon = isFinal ? '✓' : issue.status === 'in_progress' ? '⏱' : '—'
  const elapsedLabel = elapsedMs == null ? '—' : formatDuration(elapsedMs)
  return (
    <li
      className={`${styles.issueItem} ${selectedIssueId === issue.id ? styles.active : ''}`}
      onClick={onSelect}
    >
      <div className={styles.issueTitleRow}>
        <span className={`${styles.issueTypeLabel} ${issue.type === 'collaboration' ? styles.collabLabel : styles.taskLabel}`}>
          {issue.type === 'collaboration' ? '协作' : '任务'}
        </span>
        {issue.slash_command && (
          <span
            title="此 issue 以计划模式执行：先输出方案，等待审批后落盘"
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: '1px 6px',
              borderRadius: 4,
              background: 'rgba(99, 102, 241, 0.15)',
              color: '#6366f1',
            }}
          >
            {issue.slash_command}
          </span>
        )}
        <span className={styles.issueTitle}>{displayTitle(issue)}</span>
      </div>
      <div className={styles.issueMeta}>
        <Badge tone="status" value={issue.status}>
          {issue.status === 'open' ? '待处理' :
           issue.status === 'in_progress' ? (issue.type === 'collaboration' ? '协作中' : '执行中') :
           issue.status === 'paused' ? '待继续' :
           issue.status === 'completed' ? '已完成' :
           issue.status === 'failed' ? '失败' : '已取消'}
        </Badge>
        {issue.type === 'collaboration' && issue.current_round != null && (
          <span style={{ fontSize: 11, color: '#888' }}>R{issue.current_round}/{issue.max_rounds}</span>
        )}
        <span
          className={`${styles.issueElapsed} ${elapsedClass}`}
          title={elapsedMs == null ? '尚未开始' : isFinal ? '总耗时' : '当前区间耗时(实时刷新)'}
        >
          {elapsedIcon} {elapsedLabel}
        </span>
        <span
          className={`${styles.issueAssignee} ${assignee ? styles.issueAssigneeClaimed : styles.issueAssigneeUnclaimed}`}
          title={assignee ? `执行 agent: ${assignee}` : '尚未认领'}
        >
          {assignee ? `👤 ${assignee}` : UNCLAIMED_LABEL}
        </span>
        <span className={styles.issueCreatedBy}>{issue.created_by}</span>
      </div>
    </li>
  )
}

interface IssuePanelProps {
  selectedGroupId: string
  selectedIssueId: string
  selectedIssueVersion: number
  issues: Issue[]
  agents: Agent[]
  groupMembers: string[]
  myAgentName: string
  setSelectedIssueId: (id: string) => void
  onCreateIssue: (data: {
    description: string
    title?: string
    priority?: string
    assignedTo?: string
  }) => void
  onCreateCollaboration: (data: {
    title: string
    collaborationGoal: string
    participants: string[]
    maxRounds: number
    owner?: string
    createdBy: string
  }) => void
  /** 访客模式:隐藏创建按钮、详情内的写操作。 */
  readOnly?: boolean
}

export function IssuePanel({
  selectedIssueId,
  selectedIssueVersion,
  issues,
  agents,
  groupMembers,
  myAgentName,
  setSelectedIssueId,
  onCreateIssue,
  onCreateCollaboration,
  readOnly = false,
}: IssuePanelProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  return (
    <>
      <div className={styles.issuePanel}>
        <div className={styles.issuePanelHeader}>
          <h3 className={styles.issuePanelTitle}>Issues</h3>
          {!readOnly && (
            <div style={{ display: 'flex', gap: 4 }}>
              <Button variant="ghost" size="sm" onClick={() => setShowCreateDialog(true)}>+ 创建</Button>
            </div>
          )}
        </div>
        {selectedIssueId ? (
          <IssueDetail
            issueId={selectedIssueId}
            refreshSignal={selectedIssueVersion}
            agents={agents}
            groupMembers={groupMembers}
            onBack={() => setSelectedIssueId('')}
            readOnly={readOnly}
          />
        ) : issues.length === 0 ? (
          <div className={styles.issueEmpty}>
            暂无 Issue{!readOnly && <><br />点击上方按钮创建</>}
          </div>
        ) : (
          <ul className={styles.issueList}>
            {issues.map(issue => (
              <IssueListItem
                key={issue.id}
                issue={issue}
                agents={agents}
                selectedIssueId={selectedIssueId}
                onSelect={() => setSelectedIssueId(issue.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {!readOnly && (
        <CreateIssueDialog
          open={showCreateDialog}
          agents={agents}
          groupMembers={groupMembers}
          myAgentName={myAgentName}
          onClose={() => setShowCreateDialog(false)}
          onCreateIssue={(data) => {
            onCreateIssue(data)
          }}
          onCreateCollaboration={(data) => {
            onCreateCollaboration(data)
          }}
        />
      )}
    </>
  )
}
