import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import type { Group } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useVisitorMode } from '../../context/VisitorContext'
import { IssueDetail } from './IssueDetail'
import styles from './IssueDetail/IssueDetail.module.css'

export function IssueDetailPage() {
  const { groupId = '', issueId = '' } = useParams<{ groupId: string; issueId: string }>()
  const navigate = useNavigate()
  const { agents, groups } = useChatContext()
  const { lastIssueChange } = useSocket()
  const { isVisitor, validate: validateVisitor, error: visitorError, token: visitorToken, groupId: visitorResolvedGroupId } = useVisitorMode()

  const [fallbackGroup, setFallbackGroup] = useState<Group | null>(null)
  const [refreshSignal, setRefreshSignal] = useState(0)

  const groupFromContext = useMemo(
    () => groups.find(g => g.id === groupId),
    [groups, groupId],
  )

  // 访客 token 验证:visitorResolvedGroupId 等于当前 groupId 表示已验过。
  useEffect(() => {
    if (!visitorToken || !groupId) return
    if (visitorResolvedGroupId === groupId) return
    validateVisitor(groupId)
  }, [visitorToken, groupId, visitorResolvedGroupId, validateVisitor])

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

  // 访客 token 验证失败 → 错误页
  if (visitorToken && visitorError) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>
            分享链接无效
          </div>
          <div style={{ fontSize: 13, color: '#64748b' }}>
            {visitorError}。请联系分享者重新生成链接。
          </div>
        </div>
      </div>
    )
  }

  // 访客 token 验证中
  if (visitorToken && !isVisitor) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <span style={{ color: '#64748b' }}>正在验证分享链接…</span>
      </div>
    )
  }

  if (!issueId) return <div className={styles.issueEmpty}>Issue 未找到</div>

  return (
    <IssueDetail
      issueId={issueId}
      refreshSignal={refreshSignal}
      agents={agents}
      groupMembers={groupMembers}
      onBack={() => navigate(`/dashboard/groups/${groupId}/issues-single`)}
      standalone
      readOnly={isVisitor}
    />
  )
}
