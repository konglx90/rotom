import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSocket } from '../../context/SocketContext'
import { issuesApi, type IssueDetail } from '../../api/issues'
import type { IssueEvent } from '../../api/types'
import {
  DEFAULT_DURATION_MS,
  MAX_VISIBLE,
  type NotificationApi,
  type NotificationKind,
  type NotificationOptions,
  type NotificationPayload,
} from './types'

interface NotificationContextValue extends NotificationApi {
  /** 当前队列中可见的卡片(最多 MAX_VISIBLE 张)。 */
  visible: NotificationPayload[]
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

/** 队列最大长度,避免极端场景下无限堆积。超过则丢弃最老的。 */
const MAX_QUEUE = 50

/** 同一 issue 在 issue_changed 风暴里两次拉取详情的最小间隔,避免 N 个 event 连发 → N 次 HTTP。 */
const ISSUE_REFETCH_DEBOUNCE_MS = 600

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readEventMeta(ev: IssueEvent): Record<string, unknown> {
  try {
    return JSON.parse(ev.metadata || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

/** event_type=approval_request 且未解决的算 pending approval。 */
function isPendingApproval(ev: IssueEvent): boolean {
  if (ev.event_type !== 'approval_request') return false
  const m = readEventMeta(ev)
  return !m.resolvedAt && !m.resolvedBy
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<NotificationPayload[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 已通知过的 approvalId 集合,避免同一审批在多次 issue_changed 中重复弹。
  const notifiedApprovalsRef = useRef<Set<string>>(new Set())
  // 上次看到的 issue status,用来判断完成/失败的状态翻转。
  const lastIssueStatusRef = useRef<Map<string, string>>(new Map())
  // 正在 inflight 的 issue 详情拉取,防并发。
  const inflightFetchesRef = useRef<Map<string, Promise<void>>>(new Map())
  // 待触发的 debounced 拉取 timer。
  const pendingFetchTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const clearTimer = useCallback((id: string) => {
    const t = timersRef.current.get(id)
    if (t) {
      clearTimeout(t)
      timersRef.current.delete(id)
    }
  }, [])

  const dismiss = useCallback((id: string) => {
    clearTimer(id)
    setQueue(prev => prev.filter(n => n.id !== id))
  }, [clearTimer])

  const push = useCallback((kind: NotificationKind, title: string, opts?: NotificationOptions) => {
    const id = genId()
    const payload: NotificationPayload = {
      id,
      kind,
      title,
      description: opts?.description,
      duration: opts?.duration ?? DEFAULT_DURATION_MS[kind],
      actions: opts?.actions,
      createdAt: Date.now(),
    }
    setQueue(prev => {
      const next = [...prev, payload]
      if (next.length > MAX_QUEUE) {
        const dropped = next.shift()
        if (dropped) clearTimer(dropped.id)
      }
      return next
    })
    if (payload.duration && payload.duration > 0) {
      const timer = setTimeout(() => dismiss(id), payload.duration)
      timersRef.current.set(id, timer)
    }
    return id
  }, [clearTimer, dismiss])

  const clear = useCallback(() => {
    timersRef.current.forEach(t => clearTimeout(t))
    timersRef.current.clear()
    setQueue([])
  }, [])

  const api = useMemo<NotificationApi>(() => ({
    success: (t, o) => push('success', t, o),
    error:   (t, o) => push('error', t, o),
    warning: (t, o) => push('warning', t, o),
    info:    (t, o) => push('info', t, o),
    dismiss,
    clear,
  }), [push, dismiss, clear])

  useEffect(() => {
    const timers = timersRef.current
    const pendingTimers = pendingFetchTimersRef.current
    const inflight = inflightFetchesRef.current
    return () => {
      timers.forEach(t => clearTimeout(t))
      timers.clear()
      pendingTimers.forEach(t => clearTimeout(t))
      pendingTimers.clear()
      inflight.clear()
    }
  }, [])

  const { subscribe } = useSocket()
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location.pathname)
  useEffect(() => { locationRef.current = location.pathname }, [location.pathname])

  const apiRef = useRef(api)
  useEffect(() => { apiRef.current = api }, [api])

  /** 是否正在某个 issue 的详情页(避免双提示:页面上已经有 PendingApprovalsBar)。 */
  function isViewingIssue(issueId: string): boolean {
    return locationRef.current.includes(`/issues/${issueId}`)
      || locationRef.current.includes(`/issues-single/`)
  }

  /** 拉 issue 详情并比对 status / approval 变化。 */
  const fetchAndCompareIssue = useCallback(async (issueId: string) => {
    let detail: IssueDetail
    try {
      detail = await issuesApi.getById(issueId)
    } catch {
      // 404 / 网络错误 静默忽略(issue 可能已删 / 短暂网络抖动)
      return
    }

    // 1. status 变化 → completed 弹 success / failed 弹 error
    const prevStatus = lastIssueStatusRef.current.get(issueId)
    const newStatus = detail.status
    if (prevStatus && prevStatus !== newStatus) {
      const issuePath = `/dashboard/groups/${detail.group_id}/issues/${issueId}`
      if (newStatus === 'completed') {
        apiRef.current.success(`Issue「${detail.title}」已完成`, {
          actions: [{
            label: '查看详情',
            primary: true,
            onClick: () => navigate(issuePath),
          }],
        })
      } else if (newStatus === 'failed') {
        apiRef.current.error(`Issue「${detail.title}」执行失败`, {
          description: detail.error_message || undefined,
          actions: [{
            label: '查看详情',
            primary: true,
            onClick: () => navigate(issuePath),
          }],
        })
      }
    }
    lastIssueStatusRef.current.set(issueId, newStatus)

    // 2. 新增 pending approval → 弹 warning(若用户不在该 issue 详情页)
    const viewing = isViewingIssue(issueId)
    if (!viewing) {
      for (const ev of detail.events) {
        if (!isPendingApproval(ev)) continue
        const m = readEventMeta(ev)
        const approvalId = typeof m.approvalId === 'string' ? m.approvalId : ''
        if (!approvalId) continue
        if (notifiedApprovalsRef.current.has(approvalId)) continue
        notifiedApprovalsRef.current.add(approvalId)

        const summary = typeof m.summary === 'string' && m.summary ? m.summary : '需要确认'
        const kind = typeof m.kind === 'string' ? m.kind : ''
        const desc = kind === 'exec' && typeof m.command === 'string'
          ? m.command
          : kind === 'file_change' && Array.isArray(m.files)
            ? (m.files as string[]).join(', ')
            : undefined

        apiRef.current.warning(`需要审批:${summary}`, {
          description: desc,
          actions: [{
            label: '去审批',
            primary: true,
            onClick: () => navigate(`/dashboard/groups/${detail.group_id}/issues/${issueId}`),
          }],
        })
      }
    }
  }, [navigate])

  /** 带 debounce 的 issue_changed 处理:event 风暴里每个 issueId 至多每 600ms 拉一次。 */
  const scheduleIssueFetch = useCallback((issueId: string) => {
    if (inflightFetchesRef.current.has(issueId)) return
    const existing = pendingFetchTimersRef.current.get(issueId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingFetchTimersRef.current.delete(issueId)
      const p = fetchAndCompareIssue(issueId).finally(() => {
        inflightFetchesRef.current.delete(issueId)
      })
      inflightFetchesRef.current.set(issueId, p)
    }, ISSUE_REFETCH_DEBOUNCE_MS)
    pendingFetchTimersRef.current.set(issueId, timer)
  }, [fetchAndCompareIssue])

  useEffect(() => {
    return subscribe((msg) => {
      switch (msg.type) {
        case 'collaboration_concluded': {
          apiRef.current.success(`协作「${msg.title}」已完成`, {
            description: msg.summary,
            actions: [{
              label: '查看详情',
              primary: true,
              onClick: () => navigate(`/dashboard/groups/${msg.groupId}/issues/${msg.issueId}`),
            }],
          })
          break
        }
        case 'a2a_stream_end': {
          // 只通知"当前打开的群",其他群不弹(避免噪音)。
          const currentGroupId = (() => {
            try { return localStorage.getItem('group_selected_id') } catch { return null }
          })()
          const msgGroupId = msg.conversation?.groupId
          if (!msgGroupId || msgGroupId !== currentGroupId) return
          const agentName = msg.from?.name || 'Agent'
          apiRef.current.info(`${agentName} 回复完成`, {
            actions: [{
              label: '查看',
              primary: true,
              onClick: () => navigate(`/dashboard/groups/${msgGroupId}`),
            }],
          })
          break
        }
        case 'issue_changed': {
          if (!msg.issueId || msg.kind === 'deleted') return
          scheduleIssueFetch(msg.issueId)
          break
        }
      }
    })
  }, [subscribe, navigate, scheduleIssueFetch])

  const visible = queue.slice(0, MAX_VISIBLE)

  const value = useMemo<NotificationContextValue>(() => ({
    ...api,
    visible,
  }), [api, visible])

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotify(): NotificationApi {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotify must be used within NotificationProvider')
  return ctx
}

/** Host 组件用来读取可见卡片。 */
export function useNotificationQueue(): NotificationPayload[] {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotificationQueue must be used within NotificationProvider')
  return ctx.visible
}

/** 暴露 dismiss 给 Host 用(点击 × 时调用)。 */
export function useNotificationDismiss() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotificationDismiss must be used within NotificationProvider')
  return ctx.dismiss
}
