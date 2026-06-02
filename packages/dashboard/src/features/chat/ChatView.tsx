import { useState, useEffect, useRef } from 'react'
import { agentsApi } from '../../api/agents'
import type { Agent } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import styles from './ChatView.module.css'

interface ChatMessage {
  id: string
  from: string
  to: string
  content: string
  timestamp: Date
  status: 'sent' | 'delivered' | 'pending' | 'failed'
  isIncoming: boolean
  streaming?: boolean
  isLoading?: boolean
}

interface ServerMessage {
  type: 'a2a_message' | 'directory_update' | 'auth_ok' | 'auth_fail' | 'route_result' | 'a2a_stream_chunk' | 'a2a_stream_end' | 'heartbeat_ack'
  requestId?: string
  from?: { name: string; domain?: string; status: string }
  payload?: { message: string }
  message?: string
  delivered?: boolean
  queued?: boolean
  error?: string
  reason?: string
  delta?: string
  event?: 'join' | 'leave' | 'update'
  agent?: {
    name: string
    domain?: string
    status: 'online' | 'offline'
  }
}

const HEARTBEAT_INTERVAL = 10_000
const RECONNECT_BASE_DELAY = 1_000
const RECONNECT_MAX_DELAY = 30_000

export function ChatView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [myAgentName, setMyAgentName] = useState<string>('')
  const [myAgentToken, setMyAgentToken] = useState<string>('')
  const [showConfig, setShowConfig] = useState<boolean>(true)
  const [message, setMessage] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)

  useEffect(() => {
    const savedName = localStorage.getItem('chat_agent_name')
    const savedToken = localStorage.getItem('chat_agent_token')
    if (savedName && savedToken) {
      setMyAgentName(savedName)
      setMyAgentToken(savedToken)
      setShowConfig(false)
    }
  }, [])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    if (!message && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [message])

  const loadAgents = async () => {
    try {
      const data = await agentsApi.list()
      const onlineAgents = data.filter((agent: Agent) => agent.status === 'online' && agent.name !== myAgentName)
      setAgents(onlineAgents)
    } catch (error) {
      console.error('Failed to load agents:', error)
    }
  }

  const clearTimers = () => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }

  const startHeartbeat = (ws: WebSocket) => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current)
    heartbeatTimerRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }))
      }
    }, HEARTBEAT_INTERVAL)
  }

  const scheduleReconnect = () => {
    const attempt = reconnectAttemptRef.current
    const jitter = Math.random() * 0.3
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt) * (1 + jitter), RECONNECT_MAX_DELAY)
    reconnectAttemptRef.current = attempt + 1
    console.log(`Reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1})`)
    reconnectTimerRef.current = setTimeout(() => {
      connectWebSocket()
    }, delay)
  }

  const connectWebSocket = () => {
    if (!myAgentName || !myAgentToken) return

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsHost = window.location.hostname === 'localhost' ? 'localhost:28800' : `${window.location.hostname}:28800`
    const wsUrl = `${wsProtocol}//${wsHost}/ws`

    console.log('Connecting to WebSocket:', wsUrl)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('WebSocket connected, sending auth...')
      setConnectionStatus('connecting')
      ws.send(JSON.stringify({
        type: 'auth',
        name: myAgentName,
        token: myAgentToken,
        version: '2'
      }))
    }

    ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data)
        console.log('WebSocket message received:', msg); console.log('Message type:', msg.type, 'Raw:', event.data)

        if (msg.type === 'auth_ok') {
          setConnectionStatus('connected')
          reconnectAttemptRef.current = 0
          startHeartbeat(ws)
          console.log('WebSocket authenticated successfully')
          loadAgents()
        }

        if (msg.type === 'heartbeat_ack') {
          // heartbeat acknowledged by server
        }

        if (msg.type === 'auth_fail') {
          setConnectionStatus('disconnected')
          clearTimers()
          console.error('WebSocket authentication failed:', msg)
          alert(`认证失败: ${msg.reason || 'Invalid token or name'}`)
          setShowConfig(true)
        }

        if (msg.type === 'a2a_message') {
          const newMessage: ChatMessage = {
            id: msg.requestId || `msg_${Date.now()}`,
            from: msg.from?.name || 'unknown',
            to: myAgentName,
            content: msg.payload?.message || '',
            timestamp: new Date(),
            status: 'delivered',
            isIncoming: true
          }
          setMessages((prev) => [...prev.filter((m) => !m.isLoading), newMessage])
        }

        if (msg.type === 'a2a_stream_chunk') {
          const rid = msg.requestId || ''
          const delta = msg.delta || ''
          const streamId = `stream_${rid}`
          setMessages((prev) => {
            const withoutLoading = prev.filter((m) => !m.isLoading)
            const existing = withoutLoading.find((m) => m.id === streamId)
            if (existing) {
              return withoutLoading.map((m) => m.id === streamId ? { ...m, content: m.content + delta } : m)
            }
            return [...withoutLoading, {
              id: streamId,
              from: msg.from?.name || 'unknown',
              to: myAgentName,
              content: delta,
              timestamp: new Date(),
              status: 'delivered',
              isIncoming: true,
              streaming: true,
            }]
          })
        }

        if (msg.type === 'a2a_stream_end') {
          const rid = msg.requestId || ''
          const streamId = `stream_${rid}`
          setMessages((prev) => prev.map((m) => m.id === streamId ? { ...m, streaming: false } : m))
        }

        if (msg.type === 'route_result') {
          setMessages((prev) => prev.map((m) =>
            m.id === msg.requestId ? { ...m, status: msg.delivered ? 'delivered' : msg.queued ? 'sent' : 'failed' } : m
          ))
        }

        if (msg.type === 'directory_update') {
          loadAgents()
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
      setConnectionStatus('disconnected')
    }

    ws.onclose = () => {
      console.log('WebSocket closed')
      setConnectionStatus('disconnected')
      clearTimers()
      if (myAgentName && myAgentToken) {
        scheduleReconnect()
      }
    }
  }

  useEffect(() => {
    if (!myAgentName || !myAgentToken) return
    connectWebSocket()
    return () => {
      clearTimers()
      wsRef.current?.close()
    }
  }, [myAgentName, myAgentToken])

  const handleSaveConfig = () => {
    if (!myAgentName.trim() || !myAgentToken.trim()) {
      alert('请填写 Agent Name 和 Token')
      return
    }
    localStorage.setItem('chat_agent_name', myAgentName.trim())
    localStorage.setItem('chat_agent_token', myAgentToken.trim())
    setShowConfig(false)
  }

  const handleSendMessage = () => {
    if (!selectedAgent || !message.trim() || connectionStatus !== 'connected') return

    const requestId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const ws = wsRef.current

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      alert('WebSocket 未连接')
      return
    }

    const newMessage: ChatMessage = {
      id: requestId,
      from: myAgentName,
      to: selectedAgent,
      content: message.trim(),
      timestamp: new Date(),
      status: 'pending',
      isIncoming: false
    }
    const loadingMessage: ChatMessage = {
      id: `loading_${requestId}`,
      from: selectedAgent,
      to: myAgentName,
      content: '',
      timestamp: new Date(),
      status: 'delivered',
      isIncoming: true,
      isLoading: true,
    }
    setMessages((prev) => [...prev, newMessage, loadingMessage])

    ws.send(JSON.stringify({
      type: 'a2a_send',
      requestId,
      target: selectedAgent,
      payload: { message: message.trim() }
    }))

    setMessage('')
  }

  return (
    <div className={styles.container}>
      {showConfig && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalContent}>
            <h2 className={styles.modalTitle}>配置你的 Agent</h2>
            <p className={styles.modalDescription}>请输入你的 OpenClaw Agent 配置信息，以便通过 WebSocket 连接到 Master。</p>

            <div className={styles.formField}>
              <label className={styles.formLabel}>Agent Name:</label>
              <input
                type="text"
                value={myAgentName}
                onChange={(e) => setMyAgentName(e.target.value)}
                placeholder="例如: my-agent-1776774031"
                className={styles.formInput}
              />
            </div>

            <div className={styles.formField}>
              <label className={styles.formLabel}>Agent Token:</label>
              <input
                type="password"
                value={myAgentToken}
                onChange={(e) => setMyAgentToken(e.target.value)}
                placeholder="例如: mesh_xxx"
                className={styles.formInput}
              />
            </div>

            <div className={styles.helpBox}>
              <p className={styles.helpBoxTitle}>如何获取配置？</p>
              <ol className={styles.helpList}>
                <li>查看你的 OpenClaw 配置文件 (~/.openclaw/openclaw.json)</li>
                <li>找到 channels.a2a-gateway.name 和 token 字段</li>
                <li>或者通过 Dashboard 创建 Agent 时获取</li>
              </ol>
            </div>

            <div className={styles.modalActions}>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  const savedName = localStorage.getItem('chat_agent_name');
                  const savedToken = localStorage.getItem('chat_agent_token');
                  if (savedName && savedToken) {
                    setMyAgentName(savedName);
                    setMyAgentToken(savedToken);
                    setShowConfig(false);
                  }
                }}
              >
                取消
              </Button>
              <Button variant="primary" size="md" onClick={handleSaveConfig}>连接</Button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.headerTitle}>与 Agent 对话</h1>
        <div className={styles.headerControls}>
          <Button variant="ghost" size="sm" onClick={() => setShowConfig(true)}>⚙️ 配置</Button>
          <div className={styles.statusIndicator}>
            <div className={`${styles.statusDot} ${styles[connectionStatus]}`}></div>
            <span className={styles.statusText}>
              {connectionStatus === 'connected' ? '已连接' : connectionStatus === 'connecting' ? '连接中...' : '未连接'}
            </span>
          </div>
        </div>
      </div>

      <div className={styles.agentSelector}>
        <label className={styles.agentSelectorLabel}>选择在线 Agent:</label>
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          disabled={connectionStatus !== 'connected'}
          className={styles.agentSelect}
        >
          <option value="">-- 请选择 Agent --</option>
          {agents.map((agent) => <option key={agent.id} value={agent.name}>{agent.name} {agent.domain && `(${agent.domain})`}</option>)}
        </select>
      </div>

      <div className={styles.messagesArea}>
        {messages.length === 0 ? (
          <p className={styles.emptyState}>{connectionStatus === 'connected' ? '暂无消息，请开始对话...' : '正在连接...'}</p>
        ) : messages.map((msg) => (
          <div key={msg.id} className={`${styles.messageRow} ${msg.isIncoming ? styles.incoming : styles.outgoing}`}>
            <Avatar name={msg.isIncoming ? msg.from : myAgentName} size={36} className={styles.messageAvatar} />
            <div className={`${styles.messageBubble} ${msg.isIncoming ? styles.incoming : styles.outgoing}`}>
              <div className={styles.messageHeader}>
                <strong>{msg.isIncoming ? msg.from : '我'}</strong>
                {msg.status !== 'delivered' && <span className={styles.messageStatus}>
                  {msg.status === 'pending' ? '⏳ 发送中...' : msg.status === 'failed' ? '❌ 发送失败' : '📤 已发送'}
                </span>}
              </div>
              <div className={styles.messageContent}>
                  {msg.isLoading ? (
                    <div className={styles.loadingDots}>
                      <span className={styles.dot}></span>
                      <span className={styles.dot}></span>
                      <span className={styles.dot}></span>
                    </div>
                  ) : <MarkdownContent content={msg.content} streaming={msg.streaming} />}
                </div>
              <div className={styles.messageTimestamp}>{msg.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputArea}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendMessage();
              e.currentTarget.style.height = 'auto';
            }
          }}
          placeholder={connectionStatus === 'connected' ? "输入消息... (Enter 发送, Shift+Enter 换行)" : "等待连接..."}
          disabled={!selectedAgent || connectionStatus !== 'connected'}
          className={styles.messageInput}
        />
        <button
          onClick={handleSendMessage}
          disabled={!selectedAgent || !message.trim() || connectionStatus !== 'connected'}
          className={styles.sendBtn}
        >
          发送
        </button>
      </div>

      <div className={styles.footerInfo}>
        <p className={styles.footerInfoTitle}>💡 提示：</p>
        <ul className={styles.footerInfoList}>
          <li>当前使用 Agent: <strong>{myAgentName || '未配置'}</strong></li>
          <li>只能与在线的 Agent 对话（不包括自己）</li>
          <li>消息通过 WebSocket 实时发送和接收</li>
        </ul>
      </div>
    </div>
  )
}
