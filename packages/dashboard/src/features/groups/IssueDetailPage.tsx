import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import type { Group } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useVisitorMode } from '../../context/VisitorContext'
import { IssueDetail } from './IssueDetail'
const LazyArtifactPanel = lazy(() => import('./ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })))
import styles from './IssueDetail/IssueDetail.module.css'

export function IssueDetailPage() {
  const { groupId = '', issueId = '' } = useParams<{ groupId: string; issueId: string }>()
  const navigate = useNavigate()
  const { agents, groups } = useChatContext()
  const { lastIssueChange, lastIssueUsageProgress, status: wsStatus, subscribeIssueDetail, unsubscribeIssueDetail } = useSocket()
  const { isVisitor, validate: validateVisitor, error: visitorError, token: visitorToken, groupId: visitorResolvedGroupId } = useVisitorMode()

  const [fallbackGroup, setFallbackGroup] = useState<Group | null>(null)
  const [refreshSignal, setRefreshSignal] = useState(0)
  // standalone 路由没有 rightPanel 堆叠可用,artifact 链接点击后从右侧滑出抽屉预览。
  // null = 抽屉关闭;string = 抽屉打开并选中该路径。
  const [artifactSelectedPath, setArtifactSelectedPath] = useState<string | null>(null)

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

  // 订阅当前 issueId 的实时 usage 推送(Master 只转发给订阅者,不广播)。
  // 依赖 wsStatus:重连成功后 SocketContext 会在 onopen 自动重发订阅,但
  // 万一漏了这里再补一次也是幂等的。issueId 切换时旧订阅先 unsubscribe。
  // 访客模式 readOnly 不订阅(无权访问 usage)。
  useEffect(() => {
    if (!issueId || isVisitor) return
    if (wsStatus !== 'connected') return
    subscribeIssueDetail(issueId)
    return () => { unsubscribeIssueDetail(issueId) }
  }, [issueId, wsStatus, isVisitor, subscribeIssueDetail, unsubscribeIssueDetail])

  // 派生 liveUsage:当前 issueId 的最新累积 usage,没匹配则 undefined(IssueStatusBar 降级到 issue.usage)。
  const liveUsage = lastIssueUsageProgress && lastIssueUsageProgress.issueId === issueId
    ? lastIssueUsageProgress.usage
    : undefined

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
    <>
      <IssueDetail
        issueId={issueId}
        refreshSignal={refreshSignal}
        agents={agents}
        groupMembers={groupMembers}
        onBack={() => navigate(`/dashboard/groups/${groupId}/issues-single`)}
        standalone
        readOnly={isVisitor}
        onArtifactClick={setArtifactSelectedPath}
        liveUsage={liveUsage}
      />
      {artifactSelectedPath !== null && (
        <div className={styles.artifactDrawer}>
          <div className={styles.drawerHeader}>
            <span className={styles.drawerTitle}>{'\u{1F4E6}'} Artifacts</span>
            <button
              type="button"
              className={styles.drawerClose}
              onClick={() => setArtifactSelectedPath(null)}
              title="关闭"
              aria-label="关闭 Artifacts 抽屉"
            >
              ×
            </button>
          </div>
          <div className={styles.drawerBody}>
            <Suspense fallback={<div className={styles.drawerLoading}>加载中...</div>}>
              <LazyArtifactPanel
                groupId={groupId}
                selectedPath={artifactSelectedPath}
                onSelectedPathChange={setArtifactSelectedPath}
              />
            </Suspense>
          </div>
        </div>
      )}
    </>
  )
}
