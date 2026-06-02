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

interface SocketContextValue {
  status: ConnectionStatus
  send: (payload: unknown) => boolean
  subscribe: (fn: (msg: ServerMessage) => void) => () => void
  lastIssueChange: IssueChangeSignal | null
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

  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set())
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const tabIdRef = useRef<string>(generateUUID())

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

  const value: SocketContextValue = {
    status,
    send,
    subscribe,
    lastIssueChange,
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
