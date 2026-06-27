import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ConflictModal } from '../features/groups/modals/ConflictModal'
import type { ServerMessage } from '../features/groups/types'
import { useChatContext } from './ChatContext'

const HEARTBEAT_INTERVAL = 10_000
const RECONNECT_BASE_DELAY = 1_000
const RECONNECT_MAX_DELAY = 30_000
const ACTIVE_TAB_FRESH_MS = 30_000

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'conflict'

export interface IssueChangeSignal {
  groupId: string
  issueId: string
  kind?: string
  ts: number
}

export interface IssueUsageProgressSignal {
  issueId: string
  usage: import('../api/types').TokenUsage
  ts: number
}

interface SocketContextValue {
  status: ConnectionStatus
  send: (payload: unknown) => boolean
  subscribe: (fn: (msg: ServerMessage) => void) => () => void
  lastIssueChange: IssueChangeSignal | null
  /** 最新一次 issue_usage_progress 推送。IssueDetail 派生 liveUsage 时按 issueId 匹配。 */
  lastIssueUsageProgress: IssueUsageProgressSignal | null
  /** 订阅某 issue 详情的实时推送(只接收该 issueId 的 usage_progress,不广播)。 */
  subscribeIssueDetail: (issueId: string) => void
  /** 取消订阅;IssueDetail unmount 时调用,避免泄漏。 */
  unsubscribeIssueDetail: (issueId: string) => void
  reconnect: () => void
}

const SocketContext = createContext<SocketContextValue | null>(null)

function generateUUID(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { myAgentName, myAgentToken, loadAgents } = useChatContext()

  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [showConflictModal, setShowConflictModal] = useState(false)
  const [lastIssueChange, setLastIssueChange] = useState<IssueChangeSignal | null>(null)
  const [lastIssueUsageProgress, setLastIssueUsageProgress] = useState<IssueUsageProgressSignal | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set())
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const tabIdRef = useRef<string>(generateUUID())
  /** 当前订阅的 issueId(ref 副本),ws onopen / 状态变 connected 时重发,
   *  跨重连保留(Master 端 disconnect 已清掉订阅)。null = 无订阅。 */
  const subscribedIssueIdRef = useRef<string | null>(null)

  const loadAgentsRef = useRef(loadAgents)
  useEffect(() => { loadAgentsRef.current = loadAgents }, [loadAgents])

  const clearTimers = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const startHeartbeat = useCallback((ws: WebSocket) => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current)
    heartbeatTimerRef.current = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'heartbeat' }))
      try {
        const raw = localStorage.getItem('ws_active_tab')
        if (!raw) return
        const info = JSON.parse(raw)
        if (info.tabId === tabIdRef.current) {
          info.timestamp = Date.now()
          localStorage.setItem('ws_active_tab', JSON.stringify(info))
        }
      } catch { /* non-fatal */ }
    }, HEARTBEAT_INTERVAL)
  }, [])

  const scheduleReconnectRef = useRef<() => void>(() => {})
  const connectRef = useRef<() => void>(() => {})

  const doConnect = useCallback(() => {
    if (!myAgentName || !myAgentToken) return

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsHost = window.location.hostname === 'localhost'
      ? 'localhost:28800'
      : `${window.location.hostname}:28800`
    const wsUrl = `${wsProtocol}//${wsHost}/ws`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connecting')
      ws.send(JSON.stringify({ type: 'auth', name: myAgentName, token: myAgentToken, version: '2' }))
    }

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data)
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err)
        return
      }

      if (msg.type === 'auth_ok') {
        setStatus('connected')
        reconnectAttemptRef.current = 0
        localStorage.setItem(
          'ws_active_tab',
          JSON.stringify({ tabId: tabIdRef.current, timestamp: Date.now() }),
        )
        startHeartbeat(ws)
        // 重连后重发当前 issue 订阅(Master 端 disconnect 已清掉,不重发就拿不到 usage 推送)。
        const issueId = subscribedIssueIdRef.current
        if (issueId) {
          ws.send(JSON.stringify({ type: 'subscribe_issue_detail', issueId }))
        }
      } else if (msg.type === 'auth_fail') {
        setStatus('disconnected')
        clearTimers()
      } else if (msg.type === 'issue_changed') {
        if (msg.groupId && msg.issueId) {
          setLastIssueChange({
            groupId: msg.groupId,
            issueId: msg.issueId,
            kind: msg.kind,
            ts: Date.now(),
          })
        }
      } else if (msg.type === 'issue_usage_progress') {
        // 不触发 reload(IssueDetail 局部更新 IssueStatusBar 即可),避免每秒高频刷新。
        if (msg.issueId && msg.usage) {
          setLastIssueUsageProgress({
            issueId: msg.issueId,
            usage: msg.usage,
            ts: Date.now(),
          })
        }
      } else if (msg.type === 'directory_update') {
        loadAgentsRef.current(true)
      }

      // Fan out the raw message to any subscribers (chat hook etc).
      handlersRef.current.forEach((fn) => {
        try { fn(msg) } catch (err) { console.error('socket handler error:', err) }
      })
    }

    ws.onerror = () => setStatus('disconnected')

    ws.onclose = (event) => {
      clearTimers()
      try {
        const raw = localStorage.getItem('ws_active_tab')
        if (raw) {
          const info = JSON.parse(raw)
          if (info.tabId === tabIdRef.current) localStorage.removeItem('ws_active_tab')
        }
      } catch { /* non-fatal */ }

      if (event.reason === 'Replaced by new connection') {
        setStatus('conflict')
        return
      }

      setStatus('disconnected')
      if (wsRef.current === ws && myAgentName && myAgentToken) {
        scheduleReconnectRef.current()
      }
    }
  }, [myAgentName, myAgentToken, clearTimers, startHeartbeat])

  const scheduleReconnect = useCallback(() => {
    const attempt = reconnectAttemptRef.current
    const jitter = Math.random() * 0.3
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, attempt) * (1 + jitter),
      RECONNECT_MAX_DELAY,
    )
    reconnectAttemptRef.current = attempt + 1
    reconnectTimerRef.current = setTimeout(() => {
      connectRef.current()
    }, delay)
  }, [])

  const connect = useCallback(() => {
    if (!myAgentName || !myAgentToken) return
    try {
      const raw = localStorage.getItem('ws_active_tab')
      if (raw) {
        const info = JSON.parse(raw)
        if (info.tabId !== tabIdRef.current && Date.now() - info.timestamp < ACTIVE_TAB_FRESH_MS) {
          setShowConflictModal(true)
          return
        }
      }
    } catch { /* non-fatal */ }
    doConnect()
  }, [myAgentName, myAgentToken, doConnect])

  useEffect(() => { scheduleReconnectRef.current = scheduleReconnect }, [scheduleReconnect])
  useEffect(() => { connectRef.current = connect }, [connect])

  // Clear active-tab marker on close.
  useEffect(() => {
    const cleanup = () => {
      try {
        const raw = localStorage.getItem('ws_active_tab')
        if (raw) {
          const info = JSON.parse(raw)
          if (info.tabId === tabIdRef.current) localStorage.removeItem('ws_active_tab')
        }
      } catch { /* non-fatal */ }
    }
    window.addEventListener('beforeunload', cleanup)
    return () => window.removeEventListener('beforeunload', cleanup)
  }, [])

  // Connect on credentials change.
  useEffect(() => {
    if (!myAgentName || !myAgentToken) return
    connect()
    return () => {
      clearTimers()
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [myAgentName, myAgentToken, connect, clearTimers])

  const send = useCallback((payload: unknown): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
    return true
  }, [])

  const subscribe = useCallback((fn: (msg: ServerMessage) => void) => {
    handlersRef.current.add(fn)
    return () => { handlersRef.current.delete(fn) }
  }, [])

  const reconnect = useCallback(() => {
    setShowConflictModal(false)
    doConnect()
  }, [doConnect])

  const subscribeIssueDetail = useCallback((issueId: string) => {
    // 切换 issueId 时先 unsubscribe 旧的(Master 端 Set 删除旧条目),
    // 再 subscribe 新的。同一个 issueId 重复 subscribe 是幂等的。
    const prev = subscribedIssueIdRef.current
    if (prev && prev !== issueId) {
      send({ type: 'unsubscribe_issue_detail', issueId: prev })
    }
    subscribedIssueIdRef.current = issueId
    send({ type: 'subscribe_issue_detail', issueId })
  }, [send])

  const unsubscribeIssueDetail = useCallback((issueId: string) => {
    if (subscribedIssueIdRef.current !== issueId) return
    subscribedIssueIdRef.current = null
    send({ type: 'unsubscribe_issue_detail', issueId })
  }, [send])

  const value: SocketContextValue = {
    status,
    send,
    subscribe,
    lastIssueChange,
    lastIssueUsageProgress,
    subscribeIssueDetail,
    unsubscribeIssueDetail,
    reconnect,
  }

  return (
    <SocketContext.Provider value={value}>
      {children}
      <ConflictModal
        open={showConflictModal}
        onCancel={() => {
          setShowConflictModal(false)
          setStatus('disconnected')
        }}
        onTakeover={reconnect}
      />
    </SocketContext.Provider>
  )
}

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext)
  if (!ctx) throw new Error('useSocket must be used inside <SocketProvider>')
  return ctx
}
