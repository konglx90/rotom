import { useEffect, useRef, useState } from 'react'
import { groupsApi } from '../../api/groups'
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
          const streamId = `stream_${rid}`
          const delta = msg.delta || ''
          const existing = streamContentRef.current.get(rid)
          if (existing) {
            existing.content += delta
          } else {
            streamContentRef.current.set(rid, { from: msg.from?.name || 'unknown', content: delta })
          }
          setMessages(prev => {
            const withoutLoading = prev.filter(m => !m.isLoading)
            const found = withoutLoading.find(m => m.id === streamId)
            if (found) {
              return withoutLoading.map(m =>
                m.id === streamId ? { ...m, content: m.content + delta } : m,
              )
            }
            return [...withoutLoading, {
              id: streamId,
              from: msg.from?.name || 'unknown',
              content: delta,
              timestamp: new Date(),
              isIncoming: true,
              streaming: true,
            }]
          })
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
        streamContentRef.current.delete(rid)

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
      })))
    }).catch(() => setMessages([]))
  }, [selectedGroupId, myAgentName])

  return {
    messages,
    setMessages,
  }
}
