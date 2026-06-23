import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Group, Issue } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useVisitorMode } from '../../context/VisitorContext'
import styles from './IssuePanel.module.css'
import { displayTitle } from './createIssueTitle'

const STATUS_LABEL: Record<Issue['status'], string> = {
  open: '待处理',
  in_progress: '执行中',
  paused: '待继续',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function IssuesListPage() {
  const { groupId = '' } = useParams<{ groupId: string }>()
  const { groups } = useChatContext()
  const { lastIssueChange } = useSocket()
  const { isVisitor, validate: validateVisitor, error: visitorError, token: visitorToken, groupId: visitorResolvedGroupId } = useVisitorMode()

  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fallbackGroup, setFallbackGroup] = useState<Group | null>(null)

  const groupFromContext = useMemo(
    () => groups.find(g => g.id === groupId),
    [groups, groupId],
  )
  const group = groupFromContext || fallbackGroup

  // 访客 token 验证：visitorResolvedGroupId 等于当前 groupId 表示已验过,
  // 否则触发 validate。isVisitor 不能用作已完成信号 —— 它在 validate 完成
  // 之前就是 true。
  useEffect(() => {
    if (!visitorToken || !groupId) return
    if (visitorResolvedGroupId === groupId) return
    validateVisitor(groupId)
  }, [visitorToken, groupId, visitorResolvedGroupId, validateVisitor])

  useEffect(() => {
    if (!groupId || groupFromContext) return
    let cancelled = false
    groupsApi.getById(groupId)
      .then(g => { if (!cancelled) setFallbackGroup(g) })
      .catch(() => { /* 群名拉不到不致命 */ })
    return () => { cancelled = true }
  }, [groupId, groupFromContext])

  const loadIssues = useCallback(async () => {
    if (!groupId) return
    try {
      const data = await issuesApi.listByGroup(groupId)
      setIssues(data)
      setError(null)
    } catch {
      setError('加载 Issue 列表失败')
    }
  }, [groupId])

  useEffect(() => {
    if (!groupId) return
    let cancelled = false
    setLoading(true)
    loadIssues().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [groupId, loadIssues])

  // 全局 ws 推送的 issue_changed 命中当前 groupId 时刷新列表。
  useEffect(() => {
    if (!lastIssueChange) return
    if (lastIssueChange.groupId !== groupId) return
    loadIssues()
  }, [lastIssueChange, groupId, loadIssues])

  return (
    <div className={styles.issuePanel}>
      <div className={styles.issuePanelHeader}>
        <h3 className={styles.issuePanelTitle}>
          {group?.name ? `${group.name} · SubSessions` : 'SubSessions'}
        </h3>
      </div>

      {visitorToken && visitorError && (
        <div className={styles.issueEmpty} style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>
            分享链接无效
          </div>
          <div style={{ fontSize: 13, color: '#64748b' }}>
            {visitorError}。请联系分享者重新生成链接。
          </div>
        </div>
      )}

      {visitorToken && !visitorError && !isVisitor && (
        <div className={styles.issueEmpty}>正在验证分享链接…</div>
      )}

      {(!visitorToken || isVisitor) && (loading ? (
        <div className={styles.issueEmpty}>加载中...</div>
      ) : error ? (
        <div className={styles.issueEmpty}>{error}</div>
      ) : issues.length === 0 ? (
        <div className={styles.issueEmpty}>暂无 Issue</div>
      ) : (
        <ul className={styles.issueList}>
          {issues.map(issue => (
            <li key={issue.id} className={styles.issueItem}>
              <Link
                to={`/dashboard/groups/${groupId}/issues-single/${issue.id}`}
                style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
              >
                <div className={styles.issueTitleRow}>
                  <span
                    className={`${styles.issueTypeLabel} ${
                      issue.type === 'collaboration' ? styles.collabLabel : styles.taskLabel
                    }`}
                  >
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
                    {issue.status === 'in_progress' && issue.type === 'collaboration'
                      ? '协作中'
                      : STATUS_LABEL[issue.status]}
                  </Badge>
                  {issue.type === 'collaboration' && issue.current_round != null && (
                    <span style={{ fontSize: 11, color: '#888' }}>
                      R{issue.current_round}/{issue.max_rounds}
                    </span>
                  )}
                  <span className={styles.issueCreatedBy}>{issue.created_by}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ))}
    </div>
  )
}
