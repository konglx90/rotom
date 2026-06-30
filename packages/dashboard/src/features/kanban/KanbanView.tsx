import { useCallback, useEffect, useMemo, useState } from 'react'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Agent, Group, Issue } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useIssueElapsed } from '../../hooks/useIssueElapsed'
import { formatDuration } from '../../utils/formatDuration'
import { IssueDetail } from '../groups/IssueDetail'
import { resolveAssigneeName, UNCLAIMED_LABEL } from '../groups/agentDisplayName'
import styles from './KanbanView.module.css'
import { displayTitle } from '../groups/createIssueTitle'

type IssueStatus = Issue['status']

const COLUMNS: { status: IssueStatus; label: string }[] = [
  { status: 'open', label: '待处理' },
  { status: 'in_progress', label: '执行中' },
  { status: 'paused', label: '待继续' },
  { status: 'completed', label: '已完成' },
  { status: 'failed', label: '失败' },
  { status: 'cancelled', label: '已取消' },
]

function formatRelative(iso: string): string {
  if (!iso) return ''
  const ts = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime()
  if (Number.isNaN(ts)) return ''
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day === 1) return '昨天'
  if (day < 7) return `${day} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 单卡抽成子组件:每张卡自己调 useIssueElapsed,避免 1s tick 扇出到整
// 个看板。看板一屏 6 列 × 多行,父组件 setInterval 会拖垮渲染。
function KanbanCard({
  issue,
  groupName,
  agents,
  onOpen,
}: {
  issue: Issue
  groupName: string
  agents: Agent[]
  onOpen: () => void
}) {
  const assignee = resolveAssigneeName(issue.assigned_to, agents)
  const elapsedMs = useIssueElapsed(issue.started_at, issue.completed_at)
  const isFinal = issue.status === 'completed' || issue.status === 'failed' || issue.status === 'cancelled'
  const elapsedClass = isFinal
    ? styles.cardElapsedDone
    : issue.status === 'in_progress'
      ? styles.cardElapsedRunning
      : styles.cardElapsedIdle
  const elapsedIcon = isFinal ? '✓' : issue.status === 'in_progress' ? '⏱' : '—'
  const elapsedLabel = elapsedMs == null ? '—' : formatDuration(elapsedMs)
  return (
    <button
      type="button"
      className={styles.card}
      onClick={onOpen}
    >
      <div className={styles.cardTopRow}>
        <span className={`${styles.typeTag} ${styles.typeTask}`}>
          任务
        </span>
        {issue.slash_command && (
          <span className={styles.slashTag} title="计划模式">{issue.slash_command}</span>
        )}
        <Badge tone="priority" value={issue.priority}>{issue.priority}</Badge>
      </div>
      <div className={styles.cardTitle}>{displayTitle(issue)}</div>
      <div className={styles.cardMeta}>
        <span className={styles.groupName} title={`群: ${groupName}`}>
          # {groupName}
        </span>
        <span
          className={`${styles.assignee} ${assignee ? styles.assigneeClaimed : styles.assigneeUnclaimed}`}
          title={assignee ? `执行 agent: ${assignee}` : '尚未认领'}
        >
          {assignee ? `👤 ${assignee}` : UNCLAIMED_LABEL}
        </span>
      </div>
      <div className={styles.cardFoot}>
        <span className={styles.time} title={issue.created_at}>
          {formatRelative(issue.created_at)}
        </span>
        <span
          className={`${styles.cardElapsed} ${elapsedClass}`}
          title={elapsedMs == null ? '尚未开始' : isFinal ? '总耗时' : '当前区间耗时(实时刷新)'}
        >
          {elapsedIcon} {elapsedLabel}
        </span>
      </div>
    </button>
  )
}

export function KanbanView() {
  const { groups, agents } = useChatContext()
  const { lastIssueChange } = useSocket()

  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [openIssue, setOpenIssue] = useState<{ id: string; groupId: string } | null>(null)
  const [drawerGroup, setDrawerGroup] = useState<Group | null>(null)
  const [drawerRefresh, setDrawerRefresh] = useState(0)

  const groupNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups) m.set(g.id, g.name)
    return m
  }, [groups])

  const load = useCallback(async () => {
    try {
      const data = await issuesApi.listAll()
      setIssues(data)
      setError(null)
    } catch {
      setError('加载 Issue 失败')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load])

  // 任何群的 issue 变更都触发重拉
  useEffect(() => {
    if (!lastIssueChange) return
    load()
  }, [lastIssueChange, load])

  // 当前打开的 issue 收到 ws 推送 → bump 给 IssueDetail 内部的 refetch
  useEffect(() => {
    if (!lastIssueChange || !openIssue) return
    if (lastIssueChange.issueId === openIssue.id) setDrawerRefresh(v => v + 1)
  }, [lastIssueChange, openIssue])

  // 抽屉打开时按群补成员；用户不在该群则按需 fetch
  useEffect(() => {
    if (!openIssue) { setDrawerGroup(null); return }
    const fromCtx = groups.find(g => g.id === openIssue.groupId)
    if (fromCtx) { setDrawerGroup(fromCtx); return }
    let cancelled = false
    groupsApi.getById(openIssue.groupId)
      .then(g => { if (!cancelled) setDrawerGroup(g) })
      .catch(() => { if (!cancelled) setDrawerGroup(null) })
    return () => { cancelled = true }
  }, [openIssue, groups])

  // ESC 关闭抽屉
  useEffect(() => {
    if (!openIssue) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenIssue(null) }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [openIssue])

  const drawerMembers = useMemo(
    () => drawerGroup?.members?.map(m => m.agent_name) || [],
    [drawerGroup],
  )

  const grouped = useMemo(() => {
    const buckets: Record<IssueStatus, Issue[]> = {
      open: [], in_progress: [], paused: [], completed: [], failed: [], cancelled: [],
    }
    for (const issue of issues) {
      const bucket = buckets[issue.status]
      if (bucket) bucket.push(issue)
    }
    return buckets
  }, [issues])

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>看板</h2>
        <span className={styles.subtitle}>
          全局 {issues.length} 条 Issue
        </span>
      </div>

      {loading ? (
        <div className={styles.placeholder}>加载中…</div>
      ) : error ? (
        <div className={styles.placeholder}>{error}</div>
      ) : (
        <div className={styles.board}>
          {COLUMNS.map(({ status, label }) => {
            const items = grouped[status]
            return (
              <section key={status} className={styles.column} data-status={status}>
                <header className={styles.columnHeader}>
                  <Badge tone="status" value={status}>{label}</Badge>
                  <span className={styles.count}>{items.length}</span>
                </header>
                <div className={styles.cards}>
                  {items.length === 0 ? (
                    <div className={styles.empty}>暂无</div>
                  ) : items.map(issue => {
                    const groupName = groupNameMap.get(issue.group_id) || issue.group_id.slice(0, 6)
                    return (
                      <KanbanCard
                        key={issue.id}
                        issue={issue}
                        groupName={groupName}
                        agents={agents}
                        onOpen={() => setOpenIssue({ id: issue.id, groupId: issue.group_id })}
                      />
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {openIssue && (
        <div className={styles.drawerBackdrop} onClick={() => setOpenIssue(null)}>
          <aside
            className={styles.drawer}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              className={styles.drawerClose}
              onClick={() => setOpenIssue(null)}
              aria-label="关闭"
            >
              ✕
            </button>
            <div className={styles.drawerBody}>
              <IssueDetail
                issueId={openIssue.id}
                refreshSignal={drawerRefresh}
                agents={agents}
                groupMembers={drawerMembers}
                onBack={() => setOpenIssue(null)}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}