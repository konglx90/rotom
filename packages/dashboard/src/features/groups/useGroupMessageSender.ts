// 发消息逻辑(DM + 群):从 GroupChatView.tsx 抽出。
// 纯逻辑 hook,接收依赖返回 handleSendMessage。pushHistory/extractMentions/groupsApi
// 由本 hook 自行 import。行为与原内联版本逐字一致。
import { groupsApi } from '../../api/groups'
import type { Group } from '../../api/types'
import type { ChatMessage } from './types'
import { extractMentions } from './types'
import { pushHistory } from './messageHistory'
import type { ConnectionStatus } from './useGroupChatWebSocket'

interface UseGroupMessageSenderArgs {
  connectionStatus: ConnectionStatus
  isDirectMode: boolean
  selectedGroupId: string
  directTargetResolved: string
  myAgentName: string
  selectedGroup: Group | undefined
  groupMembers: string[]
  selfJoinError: { groupId: string; message: string } | null
  setSelfJoinError: (e: { groupId: string; message: string } | null) => void
  send: (payload: unknown) => boolean
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  loadGroups: () => Promise<void> | void
}

export function useGroupMessageSender({
  connectionStatus,
  isDirectMode,
  selectedGroupId,
  directTargetResolved,
  myAgentName,
  selectedGroup,
  groupMembers,
  selfJoinError,
  setSelfJoinError,
  send,
  setMessages,
  loadGroups,
}: UseGroupMessageSenderArgs) {
  const handleSendMessage = async (text: string) => {
    if (!text || connectionStatus !== 'connected') return

    const trimmed = text
    pushHistory(trimmed)

    if (isDirectMode && selectedGroupId) {
      const requestId = `dm_${Date.now()}`
      const ok = send({
        type: 'a2a_send',
        requestId,
        target: directTargetResolved,
        payload: { message: trimmed },
        conversation: { type: 'single', groupId: selectedGroupId, groupName: selectedGroup?.name },
      })
      if (!ok) return
      setMessages((prev) => [
        ...prev,
        {
          id: requestId,
          from: myAgentName,
          content: trimmed,
          timestamp: new Date(),
          isIncoming: false,
          status: 'pending',
        },
        {
          id: `${requestId}_loading`,
          from: directTargetResolved,
          content: '',
          timestamp: new Date(),
          isIncoming: true,
          isLoading: true,
        },
      ])
      return
    }

    if (!selectedGroupId) return

    try {
      await groupsApi.addMembers(selectedGroupId, [myAgentName])
      if (selfJoinError?.groupId === selectedGroupId) {
        setSelfJoinError(null)
      }
    } catch (err) {
      setSelfJoinError({ groupId: selectedGroupId, message: '入群失败，可能影响实时消息' })
      console.error('Self-join failed; chunks may not stream live:', err)
    }
    await loadGroups()

    const memberSet = new Set(groupMembers)
    const mentions = extractMentions(trimmed).filter((name) => memberSet.has(name))
    const targets = mentions.filter((name) => name !== myAgentName)
    const baseRequestId = `grp_${Date.now()}`
    const conversation = {
      type: 'group' as const,
      groupId: selectedGroupId,
      groupName: selectedGroup?.name,
    }

    groupsApi.sendMessage(selectedGroupId, myAgentName, trimmed, mentions).catch((err) => {
      console.error('Failed to persist group message:', err)
    })

    for (let i = 0; i < targets.length; i++) {
      send({
        type: 'a2a_send',
        requestId: `${baseRequestId}_${i}`,
        target: targets[i],
        payload: { message: trimmed },
        conversation,
      })
    }

    setMessages((prev) => [
      ...prev,
      {
        id: baseRequestId,
        from: myAgentName,
        content: trimmed,
        timestamp: new Date(),
        isIncoming: false,
        mentions,
        status: targets.length > 0 ? 'pending' : 'delivered',
      },
      ...targets.map((_, i) => ({
        id: `${baseRequestId}_loading_${i}`,
        from: targets[i],
        content: '',
        timestamp: new Date(),
        isIncoming: true,
        isLoading: true,
      })),
    ])
  }

  return handleSendMessage
}
