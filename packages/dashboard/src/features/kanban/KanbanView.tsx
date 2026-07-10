import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Agent, Group, Issue } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useIssueElapsed } from '../../hooks/useIssueElapsed'
import { formatDuration } from '../../utils/formatDuration'
import { parseServerTime } from '../../utils/parseServerTime'
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
  // master 把 created_at 写成不带时区后缀的北京时间字符串;旧实现 append 'Z'
  // 把它当 UTC 解析,导致 1 小时前创建的 issue 在前 8 小时内一直显「刚刚」,
  // 之后才进入「N 分钟前」(N 比真实值少 8 小时)。parseServerTime 统一按
  // +08:00 解析,差值算准。
  if (!iso) return ''
  const ts = parseServerTime(iso)
  if (ts == null) return ''
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
  // 超过一周显完整日期。用 Asia/Shanghai 时区格式化,与列表 / 详情页一致,
  // 不再依赖浏览器时区(避免 UTC 机器上日期错位)。
  return new Date(ts).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
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

const PAGE_SIZE = 50

// 每列独立分页:completed/cancelled 累积过多时不再一次性把全表拉到前端。
// 列自己管 items/total/offset,ws 推送 lastIssueChange 时父级 bump refreshSignal
// 触发所有列重置到首页。后端 GET /issues?status=&limit=&offset= 返回 { items, total }。
function KanbanColumn({
  status,
  label,
  groupNameMap,
  agents,
  onOpenIssue,
  refreshSignal,
}: {
  status: IssueStatus
  label: string
  groupNameMap: Map<string, string>
  agents: Agent[]
  onOpenIssue: (id: string, groupId: string) => void
  refreshSignal: number
}) {
  const [items, setItems] = useState<Issue[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  // 空列默认收起:首次加载完成且 total===0 时折叠,之后用户手动切换自由;
  // 收起态下涌入新 issue 时自动展开,避免新进任务被藏。
  const [collapsed, setCollapsed] = useState(false)
  const initedRef = useRef(false)

  // 首屏 / ws 重置:从 offset 0 重新拉一页。status 切换或 refreshSignal bump 都触发。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    issuesApi
      .listPage(status, PAGE_SIZE, 0)
      .then(res => {
        if (cancelled) return
        setItems(res.items)
        setTotal(res.total)
        setOffset(res.items.length)
        setHasMore(res.items.length < res.total)
        // 首屏拉到数据后定折叠默认值:空列收起;之后用户手动切换自由,
        // 但收起态下涌入新 issue 时自动展开,避免新进任务被藏。
        if (!initedRef.current) {
          initedRef.current = true
          setCollapsed(res.total === 0)
        } else if (res.total > 0) {
          setCollapsed(false)
        }
      })
      .catch(() => { if (!cancelled) setError('加载 Issue 失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [status, refreshSignal])

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    try {
      const res = await issuesApi.listPage(status, PAGE_SIZE, offset)
      setItems(prev => [...prev, ...res.items])
      setOffset(off => off + res.items.length)
      setHasMore(offset + res.items.length < res.total)
    } catch {
      setError('加载 Issue 失败')
    } finally {
      setLoading(false)
    }
  }, [status, offset, loading, hasMore])

  const onCardsScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 64) {
      loadMore()
    }
  }, [loadMore])

  const remaining = total - items.length

  return (
    <section className={styles.column} data-status={status} data-collapsed={collapsed || undefined}>
      <header
        className={styles.columnHeader}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        aria-expanded={!collapsed}
        title={collapsed ? '点击展开' : '点击收起'}
      >
        <span className={styles.headerLeft}>
          <span className={`${styles.collapseIcon} ${collapsed ? styles.collapseIconCollapsed : ''}`}>
            ▸
          </span>
          <Badge tone="status" value={status}>{label}</Badge>
        </span>
        <span className={styles.count}>{total}</span>
      </header>
      {!collapsed && (
        <div className={styles.cards} onScroll={onCardsScroll}>
        {error ? (
          <div className={styles.empty}>{error}</div>
        ) : items.length === 0 && !loading ? (
          <div className={styles.empty}>暂无</div>
        ) : (
          <>
            {items.map(issue => {
              const groupName = groupNameMap.get(issue.group_id) || issue.group_id.slice(0, 6)
              return (
                <KanbanCard
                  key={issue.id}
                  issue={issue}
                  groupName={groupName}
                  agents={agents}
                  onOpen={() => onOpenIssue(issue.id, issue.group_id)}
                />
              )
            })}
            {loading && <div className={styles.loadMoreHint}>加载中…</div>}
            {!loading && hasMore && (
              <div className={styles.loadMoreHint}>
                向下滚动加载更多(还剩 {remaining} / {total})
              </div>
            )}
          </>
        )}
        </div>
      )}
    </section>
  )
}

export function KanbanView() {
  const { groups, agents } = useChatContext()
  const { lastIssueChange } = useSocket()

  // 看板级刷新信号:ws 推送 issue 变更时 bump,各列重置到首页。
  // 列自己负责拉数据(分页),父级不再持有 issues 全量。
  const [refreshSignal, setRefreshSignal] = useState(0)

  const [openIssue, setOpenIssue] = useState<{ id: string; groupId: string } | null>(null)
  const [drawerGroup, setDrawerGroup] = useState<Group | null>(null)
  const [drawerRefresh, setDrawerRefresh] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const urlIssueId = searchParams.get('issue')

  const groupNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups) m.set(g.id, g.name)
    return m
  }, [groups])

  // 任何群的 issue 变更都触发各列重拉首页
  useEffect(() => {
    if (!lastIssueChange) return
    setRefreshSignal(v => v + 1)
  }, [lastIssueChange])

  // 当前打开的 issue 收到 ws 推送 → bump 给 IssueDetail 内部的 refetch
  useEffect(() => {
    if (!lastIssueChange || !openIssue) return
    if (lastIssueChange.issueId === openIssue.id) setDrawerRefresh(v => v + 1)
  }, [lastIssueChange, openIssue])

  // URL ?issue=<id> → 打开抽屉。卡片点击反向写回 URL。
  useEffect(() => {
    if (!urlIssueId) { setOpenIssue(null); return }
    if (openIssue && openIssue.id === urlIssueId) return
    // URL 直接带 issue id 时(刷新/分享链接),先按 id 拉详情取 groupId,
    // 再打开抽屉 —— 分页后父级不再持有 issues 全量,没法 find。
    let cancelled = false
    issuesApi.getById(urlIssueId)
      .then(d => { if (!cancelled) setOpenIssue({ id: d.id, groupId: d.group_id }) })
      .catch(() => { if (!cancelled) setOpenIssue(null) })
    return () => { cancelled = true }
  }, [urlIssueId, openIssue])

  const openIssueById = useCallback((id: string, groupId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('issue', id)
      return next
    }, { replace: true })
    setOpenIssue({ id, groupId })
  }, [setSearchParams])

  const closeIssue = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('issue')
      return next
    }, { replace: true })
    setOpenIssue(null)
  }, [setSearchParams])

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
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeIssue() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [openIssue, closeIssue])

  const drawerMembers = useMemo(
    () => drawerGroup?.members?.map(m => m.agent_name) || [],
    [drawerGroup],
  )

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>看板</h2>
        <span className={styles.subtitle}>
          看板视图 · 每列默认加载 50 条,滚动加载更多
        </span>
      </div>

      <div className={styles.board}>
        {COLUMNS.map(({ status, label }) => (
          <KanbanColumn
            key={status}
            status={status}
            label={label}
            groupNameMap={groupNameMap}
            agents={agents}
            onOpenIssue={openIssueById}
            refreshSignal={refreshSignal}
          />
        ))}
      </div>

      {openIssue && (
        <div className={styles.drawerBackdrop} onClick={closeIssue}>
          <aside
            className={styles.drawer}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              className={styles.drawerClose}
              onClick={closeIssue}
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
                onBack={closeIssue}
              />
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}