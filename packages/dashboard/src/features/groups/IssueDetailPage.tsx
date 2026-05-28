import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import type { Group } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { IssueDetail } from './IssueDetail'
import styles from './IssueDetail/IssueDetail.module.css'

export function IssueDetailPage() {
  const { groupId = '', issueId = '' } = useParams<{ groupId: string; issueId: string }>()
  const navigate = useNavigate()
  const { agents, groups } = useChatContext()
  const { lastIssueChange } = useSocket()

  const [fallbackGroup, setFallbackGroup] = useState<Group | null>(null)
  const [refreshSignal, setRefreshSignal] = useState(0)

  const groupFromContext = useMemo(
    () => groups.find(g => g.id === groupId),
    [groups, groupId],
  )

  // 用户不在该群时,context.groups 找不到,单独拉一次拿成员
  useEffect(() => {
    if (!groupId || groupFromContext) return
    let cancelled = false
    groupsApi.getById(groupId)
      .then(g => { if (!cancelled) setFallbackGroup(g) })
      .catch(() => { /* 不致命,成员就是空数组 */ })
    return () => { cancelled = true }
  }, [groupId, groupFromContext])

  const groupMembers = useMemo(() => {
    const g = groupFromContext || fallbackGroup
    return g?.members?.map(m => m.agent_name) || []
  }, [groupFromContext, fallbackGroup])

  // 全局 ws 推送的 issue_changed 命中当前 issueId 时触发 refetch。
  useEffect(() => {
    if (!lastIssueChange) return
    if (lastIssueChange.issueId !== issueId) return
    setRefreshSignal(v => v + 1)
  }, [lastIssueChange, issueId])

  if (!issueId) return <div className={styles.issueEmpty}>Issue 未找到</div>

  return (
    <IssueDetail
      issueId={issueId}
      refreshSignal={refreshSignal}
      agents={agents}
      groupMembers={groupMembers}
      onBack={() => navigate(`/dashboard/groups/${groupId}/issues-single`)}
      standalone
    />
  )
}
