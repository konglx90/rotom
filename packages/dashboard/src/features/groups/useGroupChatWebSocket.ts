import { useEffect, useRef, useState, useCallback } from 'react'
import { groupsApi } from '../../api/groups'
import { messagesApi } from '../../api/messages'
import { useSocket } from '../../context/SocketContext'
import type { ChatMessage, ServerMessage } from './types'
import { extractMentions } from './types'

// Re-export so existing imports from `./useGroupChatWebSocket` keep working.
export type { ConnectionStatus } from '../../context/SocketContext'

interface UseGroupChatWebSocketParams {
  myAgentName: string
  selectedGroupId: string
  directTarget: string
}

export function useGroupChatWebSocket({
  myAgentName,
  selectedGroupId,
  directTarget,
}: UseGroupChatWebSocketParams) {
  const { subscribe } = useSocket()

  const [messages, setMessages] = useState<ChatMessage[]>([])

  const streamContentRef = useRef<Map<string, { from: string; content: string }>>(new Map())
  const selectedGroupIdRef = useRef(selectedGroupId)
  const directTargetRef = useRef(directTarget)
  const myAgentNameRef = useRef(myAgentName)

  // 流式批处理:每个 token 直接 setState 会让 50-80Hz 的 token 流触发
  // 整棵 messages 子树协调 N 次/秒,主线程被打爆。这里把同帧到达的多个
  // delta 攒到 pendingDeltasRef,用 RAF 节流到每帧最多 commit 一次。
  const rafIdRef = useRef<number | null>(null)
  const pendingDeltasRef = useRef<Map<string, { from: string; content: string }>>(new Map())

  const flushPendingDeltas = () => {
    rafIdRef.current = null
    const pending = pendingDeltasRef.current
    if (pending.size === 0) return
    pendingDeltasRef.current = new Map()
    setMessages(prev => {
      let next = prev.filter(m => !m.isLoading)
      let changed = prev.some(m => m.isLoading)
      for (const [rid, { from, content: delta }] of pending) {
        const streamId = `stream_${rid}`
        const idx = next.findIndex(m => m.id === streamId)
        if (idx >= 0) {
          next = next.slice()
          next[idx] = { ...next[idx], content: next[idx].content + delta }
          changed = true
        } else {
          next = [...next, {
            id: streamId,
            from,
            content: delta,
            timestamp: new Date(),
            isIncoming: true,
            streaming: true,
          }]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }

  const scheduleFlush = () => {
    if (rafIdRef.current != null) return
    rafIdRef.current = requestAnimationFrame(flushPendingDeltas)
  }

  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId
    directTargetRef.current = directTarget
    myAgentNameRef.current = myAgentName
  })

  // Subscribe to raw socket messages for chat-specific event types. The
  // SocketProvider handles auth / issue_changed / directory_update itself.
  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === 'route_result') {
        const rid = msg.requestId || ''
        if (!rid) return
        const status: ChatMessage['status'] = msg.delivered
          ? 'delivered'
          : msg.queued
            ? 'queued'
            : 'failed'
        setMessages(prev =>
          prev.map(m => {
            if (m.isIncoming) return m
            if (m.id === rid) return { ...m, status, statusError: msg.error }
            if (rid.startsWith(m.id + '_')) {
              if (m.status === 'delivered') return m
              return { ...m, status, statusError: msg.error }
            }
            return m
          }),
        )
        return
      }

      if (msg.type === 'a2a_message') {
        const senderName = msg.from?.name || 'unknown'
        const content = msg.payload?.message || ''
        const curGroupId = selectedGroupIdRef.current
        const curDirectTarget = directTargetRef.current
        const requestId = msg.requestId || ''

        if (msg.conversation?.type === 'group' && msg.conversation.groupId === curGroupId) {
          setMessages(prev => {
            if (prev.some(m => m.id === requestId || m.id === `stream_${requestId}`)) return prev
            return [...prev.filter(m => !m.isLoading), {
              id: requestId || `msg_${Date.now()}`,
              from: senderName,
              content,
              timestamp: new Date(),
              isIncoming: true,
              mentions: extractMentions(content),
              cwd: msg.cwd,
            }]
          })
        }

        if (
          curDirectTarget &&
          senderName === curDirectTarget &&
          msg.conversation?.type === 'single' &&
          msg.conversation?.groupId === curGroupId
        ) {
          setMessages(prev => {
            if (prev.some(m => m.id === requestId || m.id === `stream_${requestId}`)) return prev
            return [...prev.filter(m => !m.isLoading), {
              id: requestId || `dm_${Date.now()}`,
              from: senderName,
              content,
              timestamp: new Date(),
              isIncoming: true,
              cwd: msg.cwd,
            }]
          })
        }
        return
      }

      if (msg.type === 'a2a_stream_chunk') {
        const curGroupId = selectedGroupIdRef.current
        const curDirectTarget = directTargetRef.current

        const handleStreamChunk = () => {
          const rid = msg.requestId || ''
          const delta = msg.delta || ''
          const existing = streamContentRef.current.get(rid)
          if (existing) {
            existing.content += delta
          } else {
            streamContentRef.current.set(rid, { from: msg.from?.name || 'unknown', content: delta })
          }
          const pending = pendingDeltasRef.current.get(rid)
          if (pending) {
            pending.content += delta
          } else {
            pendingDeltasRef.current.set(rid, { from: msg.from?.name || 'unknown', content: delta })
          }
          scheduleFlush()
        }

        if (msg.conversation?.type === 'group' && msg.conversation.groupId === curGroupId) {
          handleStreamChunk()
        }
        if (
          curDirectTarget &&
          msg.from?.name === curDirectTarget &&
          msg.conversation?.type === 'single' &&
          msg.conversation?.groupId === curGroupId
        ) {
          handleStreamChunk()
        }
        return
      }

      if (msg.type === 'a2a_stream_end') {
        const curGroupId = selectedGroupIdRef.current
        const curDirectTarget = directTargetRef.current
        const curMyName = myAgentNameRef.current

        const rid = msg.requestId || ''
        const streamId = `stream_${rid}`
        const cancelled = msg.cancelled === true
        streamContentRef.current.delete(rid)

        // 流结束时同步 flush 当前帧之前攒下的 delta,避免最后一段内容
        // 在 apply() 拉取历史消息前没合并进 streamMsg.content,导致 (from,
        // content) 匹配失败留下重复行。
        if (rafIdRef.current != null) {
          cancelAnimationFrame(rafIdRef.current)
        }
        flushPendingDeltas()

        // 中断态:partial 内容已经在 bubble 里,不再重拉历史(避免 race ——
        // 持久化的 twin 可能因为 race 还没出现,或者 (from,content) 匹配
        // 失败留下重复行)。直接 flip streaming=false + 打 cancelled 标记。
        if (cancelled) {
          const cancelledAt = new Date()
          setMessages(prev => prev.map(m => m.id === streamId
            ? { ...m, streaming: false, cancelled: true, cancelledAt, cwd: msg.cwd ?? m.cwd }
            : m,
          ))
          return
        }

        const apply = (targetGroupId: string) => {
          groupsApi.getMessages(targetGroupId).then(historyMsgs => {
            setMessages(prev => {
              const streamMsg = prev.find(m => m.id === streamId)
              const hydrated = historyMsgs.map(m => ({
                id: `gm_${m.id}`,
                from: m.sender,
                content: m.content,
                timestamp: new Date(m.created_at + (m.created_at.includes('Z') || m.created_at.includes('+') ? '' : 'Z')),
                isIncoming: m.sender !== curMyName,
                mentions: JSON.parse(m.mentions || '[]'),
                composedPrompt: m.composed_prompt,
                ...(m.cancelled_at ? {
                  cancelled: true,
                  cancelledAt: new Date(m.cancelled_at + (m.cancelled_at.includes('Z') || m.cancelled_at.includes('+') ? '' : 'Z')),
                } : {}),
              }))
              const hydratedIds = new Set(hydrated.map(h => h.id))
              // 找持久化后的"真身"消息 —— 用 (from + content) 匹配流式占位
              const persistedTwin = streamMsg
                ? hydrated.find(h => h.from === streamMsg.from && h.content === streamMsg.content)
                : null

              // Build a set of (from, content) keys for hydrated messages so we
              // can drop local bubbles (id like `dm_<ts>` or `grp_<ts>`) whose
              // persisted twin already exists. The hydration produces a fresh
              // `gm_<uuid>` id for the same message, so id-based dedup misses
              // it and we'd otherwise end up showing both copies.
              const hydratedKeys = new Set(
                hydrated.map(h => `${h.from}${h.content}`),
              )

              // 1. 移除流式占位
              let next = prev.filter(m => m.id !== streamId)
              // 2. 移除 hydrated 之外的所有历史 id(防止旧的 deleted 行残留)
              //    同时把"已经在历史里"的本地乐观写入行也清掉,避免重复显示。
              next = next
                .filter(m => {
                  if (m.id.startsWith('gm_')) return hydratedIds.has(m.id)
                  const key = `${m.from}${m.content}`
                  return !hydratedKeys.has(key)
                })
                .map(m => m)
              // 3. 如果有真身,合并进去(并去重)
              if (persistedTwin && !next.some(m => m.id === persistedTwin.id)) {
                next = [...next, persistedTwin]
              }
              // 4. 把 hydrated 中"在 prev 里没出现过的"也加进来
              const nextIds = new Set(next.map(m => m.id))
              const newcomers = hydrated.filter(h => !nextIds.has(h.id))
              next = [...next, ...newcomers]

              return next.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
            })
          }).catch(() => {
            setMessages(prev => prev.map(m => m.id === streamId ? { ...m, streaming: false, cwd: msg.cwd ?? m.cwd } : m))
          })
        }

        if (msg.conversation?.type === 'group' && msg.conversation.groupId === curGroupId && curGroupId) {
          apply(curGroupId)
        }
        if (
          curDirectTarget &&
          msg.from?.name === curDirectTarget &&
          msg.conversation?.type === 'single' &&
          msg.conversation?.groupId === curGroupId &&
          curGroupId
        ) {
          apply(curGroupId)
        }
      }
    })
  }, [subscribe])

  // Load history when switching groups.
  useEffect(() => {
    if (!selectedGroupId) {
      setMessages([])
      return
    }
    groupsApi.getMessages(selectedGroupId).then(msgs => {
      setMessages(msgs.map(m => ({
        id: `gm_${m.id}`,
        from: m.sender,
        content: m.content,
        timestamp: new Date(m.created_at + (m.created_at.includes('Z') || m.created_at.includes('+') ? '' : 'Z')),
        isIncoming: m.sender !== myAgentName,
        mentions: JSON.parse(m.mentions || '[]'),
        composedPrompt: m.composed_prompt,
        ...(m.cancelled_at ? {
          cancelled: true,
          cancelledAt: new Date(m.cancelled_at + (m.cancelled_at.includes('Z') || m.cancelled_at.includes('+') ? '' : 'Z')),
        } : {}),
      })))
    }).catch(() => setMessages([]))
  }, [selectedGroupId, myAgentName])

  // 卸载时取消挂起的 RAF,避免 setMessages 打到已卸载组件上。
  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [])

  // 主动中断:POST /api/messages/cancel → master → WS chat_cancelled → worker。
  // 失败只 console.warn,不抛错(响应方可能刚好掉线或已自然结束,UI 自然回落)。
  const cancelStream = useCallback(async (requestId: string, agentName: string) => {
    try {
      await messagesApi.cancel(requestId, agentName)
    } catch (err) {
      console.warn('cancelStream failed:', err)
    }
  }, [])

  // 找出某个 agent 当前 streaming 中的 requestId(用于"自动中断再发送" ——
  // 用户给同一 agent 发新消息时,先把它的在飞流打断)。streamId 形如
  // `stream_msg_xxx`,要去掉前缀还原成 master / worker 那边的 requestId。
  // 使用 ref 实时读最新 messages,避免 useCallback 依赖 messages 导致
  // 频繁重建(每来一个 chunk 就 invalidate 一次)。
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const getStreamingRequestIdForAgent = useCallback((agentName: string): string | undefined => {
    const m = messagesRef.current.find(x => x.streaming && x.isIncoming && x.from === agentName)
    if (!m) return undefined
    return m.id.startsWith('stream_') ? m.id.slice('stream_'.length) : m.id
  }, [])

  return {
    messages,
    setMessages,
    cancelStream,
    getStreamingRequestIdForAgent,
  }
}
