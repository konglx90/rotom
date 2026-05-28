import { useState } from 'react'
import type { Agent, Issue } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { useReadOnly, READ_ONLY_TITLE } from '../../hooks/useReadOnly'
import { IssueDetail } from './IssueDetail'
import { CreateIssueModal } from './CreateIssueModal'
import { CreateCollaborationModal } from './CreateCollaborationModal'
import styles from './IssuePanel.module.css'

interface IssuePanelProps {
  selectedGroupId: string
  selectedIssueId: string
  selectedIssueVersion: number
  issues: Issue[]
  agents: Agent[]
  groupMembers: string[]
  myAgentName: string
  setSelectedIssueId: (id: string) => void
  defaultWorkingDir?: string
  onCreateIssue: (data: {
    title: string
    description?: string
    priority?: string
    workingDir?: string
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
}

export function IssuePanel({
  selectedIssueId,
  selectedIssueVersion,
  issues,
  agents,
  groupMembers,
  myAgentName,
  setSelectedIssueId,
  defaultWorkingDir,
  onCreateIssue,
  onCreateCollaboration,
}: IssuePanelProps) {
  const readOnly = useReadOnly()
  const [showCreateIssueModal, setShowCreateIssueModal] = useState(false)
  const [showCreateCollaborationModal, setShowCreateCollaborationModal] = useState(false)

  return (
    <>
      <div className={styles.issuePanel}>
        <div className={styles.issuePanelHeader}>
          <h3 className={styles.issuePanelTitle}>Issues</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            <Button variant="ghost" size="sm" onClick={() => setShowCreateIssueModal(true)}
              disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined}>+ 任务</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCreateCollaborationModal(true)}
              disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined}>+ 协作</Button>
          </div>
        </div>
        {selectedIssueId ? (
          <IssueDetail
            issueId={selectedIssueId}
            refreshSignal={selectedIssueVersion}
            agents={agents}
            groupMembers={groupMembers}
            onBack={() => setSelectedIssueId('')}
          />
        ) : issues.length === 0 ? (
          <div className={styles.issueEmpty}>
            暂无 Issue<br />点击上方按钮创建
          </div>
        ) : (
          <ul className={styles.issueList}>
            {issues.map(issue => (
              <li key={issue.id}
                className={`${styles.issueItem} ${selectedIssueId === issue.id ? styles.active : ''}`}
                onClick={() => setSelectedIssueId(issue.id)}>
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
                  <span className={styles.issueTitle}>{issue.title}</span>
                </div>
                <div className={styles.issueMeta}>
                  <Badge tone="status" value={issue.status}>
                    {issue.status === 'open' ? '待处理' :
                     issue.status === 'in_progress' ? (issue.type === 'collaboration' ? '协作中' : '执行中') :
                     issue.status === 'completed' ? '已完成' :
                     issue.status === 'failed' ? '失败' : '已取消'}
                  </Badge>
                  {issue.type === 'collaboration' && issue.current_round != null && (
                    <span style={{ fontSize: 11, color: '#888' }}>R{issue.current_round}/{issue.max_rounds}</span>
                  )}
                  <span className={styles.issueCreatedBy}>{issue.created_by}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateIssueModal
        open={showCreateIssueModal}
        agents={agents}
        onClose={() => setShowCreateIssueModal(false)}
        onSubmit={(data) => {
          onCreateIssue(data)
          setShowCreateIssueModal(false)
        }}
        defaultWorkingDir={defaultWorkingDir}
      />

      <CreateCollaborationModal
        open={showCreateCollaborationModal}
        agents={agents}
        groupMembers={groupMembers}
        onClose={() => setShowCreateCollaborationModal(false)}
        onSubmit={(data) => {
          onCreateCollaboration(data)
          setShowCreateCollaborationModal(false)
        }}
        createdBy={myAgentName}
      />
    </>
  )
}
