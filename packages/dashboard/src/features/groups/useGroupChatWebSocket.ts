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

        if (msg.conversation?.type === 'group' && msg.conversation.groupId === curGroupId) {
          const rid = msg.requestId || ''
          const streamId = `stream_${rid}`
          streamContentRef.current.delete(rid)
          setMessages(prev => prev.map(m => m.id === streamId ? { ...m, streaming: false } : m))
          if (curGroupId) {
            groupsApi.getMessages(curGroupId).then(historyMsgs => {
              setMessages(prev => {
                const existingIds = new Set(prev.map(m => m.id))
                const existingSigs = new Set(prev.map(m => `${m.from}::${m.content}`))
                const newFromHistory = historyMsgs
                  .map(m => ({
                    id: `gm_${m.id}`,
                    from: m.sender,
                    content: m.content,
                    timestamp: new Date(m.created_at + (m.created_at.includes('Z') || m.created_at.includes('+') ? '' : 'Z')),
                    isIncoming: m.sender !== curMyName,
                    mentions: JSON.parse(m.mentions || '[]'),
                  }))
                  .filter(m => !existingIds.has(m.id) && !existingSigs.has(`${m.from}::${m.content}`))
                if (newFromHistory.length === 0) return prev
                return [...prev, ...newFromHistory].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
              })
            }).catch(() => {})
          }
        }

        if (
          curDirectTarget &&
          msg.from?.name === curDirectTarget &&
          msg.conversation?.type === 'single' &&
          msg.conversation?.groupId === curGroupId
        ) {
          const rid = msg.requestId || ''
          const streamId = `stream_${rid}`
          streamContentRef.current.delete(rid)
          setMessages(prev => prev.map(m => m.id === streamId ? { ...m, streaming: false } : m))
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
      })))
    }).catch(() => setMessages([]))
  }, [selectedGroupId, myAgentName])

  return {
    messages,
    setMessages,
  }
}
