import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Issue } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useZenMode } from '../../context/ZenModeContext'
import { extractMentions } from './types'
import { useGroupChatWebSocket } from './useGroupChatWebSocket'
import { pushHistory } from './messageHistory'
import { DirectChatArea } from './DirectChatArea'
import { GroupChatArea } from './GroupChatArea'
import { IssuePanel } from './IssuePanel'
import { ArtifactPanel } from './ArtifactPanel'
import { AddMemberModal } from './modals/AddMemberModal'
import styles from './GroupChatView.module.css'
import chatStyles from './ChatArea.module.css'

export function GroupChatView() {
  const navigate = useNavigate()
  const { groupId: urlGroupId, issueId: urlIssueId } = useParams<{
    groupId?: string
    issueId?: string
  }>()
  const { zenMode } = useZenMode()
  const {
    agents,
    groups,
    myAgentName,
    directTarget,
    openConfigModal,
    loadGroups,
    updateGroupWorkingDir,
  } = useChatContext()
  const { status: connectionStatus, send, lastIssueChange, reconnect } = useSocket()

  const [issues, setIssues] = useState<Issue[]>([])
  const [selectedIssueVersion, setSelectedIssueVersion] = useState(0)
  const [rightTab, setRightTab] = useState<'issues' | 'artifacts'>('issues')
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)

  // Routing
  const selectedGroupId = urlGroupId || ''
  const setSelectedGroupId = (id: string) => {
    if (id) {
      localStorage.setItem('group_selected_id', id)
      navigate(`/dashboard/groups/${id}`)
    } else {
      navigate('/dashboard/groups')
    }
  }

  const selectedIssueId = urlIssueId || ''
  const setSelectedIssueId = (id: string) => {
    if (!selectedGroupId) return
    if (id) {
      navigate(`/dashboard/groups/${selectedGroupId}/issues/${id}`)
    } else {
      navigate(`/dashboard/groups/${selectedGroupId}`)
    }
  }

  const loadIssues = useCallback(async () => {
    if (!selectedGroupId) return
    try {
      const data = await issuesApi.listByGroup(selectedGroupId)
      setIssues(data)
    } catch (error) {
      console.error('Failed to load issues:', error)
    }
  }, [selectedGroupId])

  useEffect(() => {
    if (!selectedGroupId) {
      setIssues([])
      setSelectedIssueId('')
      return
    }
    loadIssues()
  }, [selectedGroupId, loadIssues])

  // Redirect: bare /dashboard/groups → restore saved group
  useEffect(() => {
    if (urlGroupId) return
    const saved = localStorage.getItem('group_selected_id')
    if (saved) navigate(`/dashboard/groups/${saved}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- WebSocket hook ---
  const {
    messages,
    setMessages,
  } = useGroupChatWebSocket({
    myAgentName,
    selectedGroupId,
    directTarget,
  })

  // React to global socket pushes. The SocketProvider tracks the latest
  // `issue_changed` event; we filter by our current group/issue and refresh
  // accordingly. Standalone IssuesListPage / IssueDetailPage subscribe the
  // same way, so the deep-link routes auto-update without a GroupChatView.
  useEffect(() => {
    if (!lastIssueChange) return
    if (lastIssueChange.groupId !== selectedGroupId) return
    loadIssues()
    if (lastIssueChange.issueId === selectedIssueId) {
      setSelectedIssueVersion(v => v + 1)
    }
  }, [lastIssueChange, selectedGroupId, selectedIssueId, loadIssues])

  // --- Derived state ---
  const selectedGroup = groups.find((g) => g.id === selectedGroupId)
  const isDirectMode = directTarget !== ''

  // --- Handlers ---
  const handleSendMessage = (text: string) => {
    if (!text || connectionStatus !== 'connected') return

    const trimmed = text
    pushHistory(trimmed)

    if (isDirectMode && selectedGroupId) {
      const requestId = `dm_${Date.now()}`
      const ok = send({
        type: 'a2a_send',
        requestId,
        target: directTarget,
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
          from: directTarget,
          content: '',
          timestamp: new Date(),
          isIncoming: true,
          isLoading: true,
        },
      ])
      return
    }

    if (!selectedGroupId) return
    const mentions = extractMentions(trimmed)
    const targets = mentions.filter((name) => name !== myAgentName)
    const baseRequestId = `grp_${Date.now()}`
    const conversation = {
      type: 'group' as const,
      groupId: selectedGroupId,
      groupName: selectedGroup?.name,
    }

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

    if (targets.length === 0) {
      groupsApi.sendMessage(selectedGroupId, myAgentName, trimmed, mentions).catch((err) => {
        console.error('Failed to persist group message:', err)
      })
    }
  }

  // Reset messages on conversation change. The WebSocket hook also loads
  // history, so this just guarantees we don't show stale messages briefly.
  const lastConvKeyRef = useRef<string>('')
  useEffect(() => {
    const key = `${selectedGroupId}::${directTarget}`
    if (lastConvKeyRef.current && lastConvKeyRef.current !== key) {
      setMessages([])
    }
    lastConvKeyRef.current = key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId, directTarget])

  const handleAddMembers = async (memberNames: string[]) => {
    if (!selectedGroupId) return
    try {
      await groupsApi.addMembers(selectedGroupId, memberNames)
      setShowAddMemberModal(false)
      loadGroups()
    } catch (error) {
      console.error('Failed to add members:', error)
    }
  }

  const handleDeleteGroup = async () => {
    if (!selectedGroupId) return
    if (!confirm('确定要删除这个群吗？')) return
    try {
      await groupsApi.delete(selectedGroupId)
      setSelectedGroupId('')
      loadGroups()
    } catch (error) {
      console.error('Failed to delete group:', error)
    }
  }

  const handleCreateIssue = async (data: {
    title: string
    description?: string
    priority?: string
    workingDir?: string
    assignedTo?: string
  }) => {
    if (!selectedGroupId) return
    try {
      const result = await issuesApi.create(selectedGroupId, {
        title: data.title,
        description: data.description,
        priority: data.priority as any,
        createdBy: myAgentName,
        workingDir: data.workingDir,
      })
      if (data.assignedTo && result.id) {
        await issuesApi.update(result.id, { assignedTo: data.assignedTo })
      }
      loadIssues()
    } catch (error) {
      console.error('Failed to create issue:', error)
    }
  }

  const handleCreateCollaboration = async (data: {
    title: string
    collaborationGoal: string
    participants: string[]
    maxRounds: number
    owner?: string
    createdBy: string
  }) => {
    if (!selectedGroupId) return
    try {
      await issuesApi.createCollaboration(selectedGroupId, data)
      loadIssues()
    } catch (error) {
      console.error('Failed to create collaboration:', error)
    }
  }

  const groupMembers = selectedGroup?.members?.map((m) => m.agent_name) || []

  return (
    <div className={`${styles.container} ${zenMode ? styles.containerZen : ''}`}>
      <AddMemberModal
        open={showAddMemberModal}
        groupMemberNames={groupMembers}
        agents={agents}
        onClose={() => setShowAddMemberModal(false)}
        onAdd={handleAddMembers}
      />

      {/* Chat Area */}
      <div className={chatStyles.chatArea}>
        {isDirectMode ? (
          <DirectChatArea
            directTarget={directTarget}
            myAgentName={myAgentName}
            messages={messages}
            connectionStatus={connectionStatus}
            onSendMessage={handleSendMessage}
            onNewDmConversation={() => {
              /* sidebar handles new DM creation now */
            }}
            onShowConfig={openConfigModal}
            onReconnect={reconnect}
            workingDir={selectedGroup?.working_dir ?? null}
            onUpdateWorkingDir={
              selectedGroupId
                ? (dir) => updateGroupWorkingDir(selectedGroupId, dir)
                : undefined
            }
          />
        ) : selectedGroup ? (
          <GroupChatArea
            selectedGroup={selectedGroup}
            agents={agents}
            myAgentName={myAgentName}
            messages={messages}
            connectionStatus={connectionStatus}
            onSendMessage={handleSendMessage}
            onShowConfig={openConfigModal}
            onAddMembers={() => setShowAddMemberModal(true)}
            onDeleteGroup={handleDeleteGroup}
            onReconnect={reconnect}
            onUpdateWorkingDir={(dir) => updateGroupWorkingDir(selectedGroup.id, dir)}
          />
        ) : (
          <div className={chatStyles.emptyChat}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 16, color: 'var(--color-navy)', marginBottom: 8 }}>
                选择在线 Agent 或群开始对话
              </p>
              <p style={{ fontSize: 13, color: 'var(--color-slate)' }}>
                左侧「一对一」直接聊天，或创建群聊 @ 成员
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Right Panel with Tabs */}
      {selectedGroup && (
        <div className={styles.rightPanel}>
          <div className={styles.rightPanelTabs}>
            <button
              className={rightTab === 'issues' ? styles.activeTab : styles.tabBtn}
              onClick={() => setRightTab('issues')}
            >
              Issues
            </button>
            <button
              className={rightTab === 'artifacts' ? styles.activeTab : styles.tabBtn}
              onClick={() => setRightTab('artifacts')}
            >
              产物
            </button>
          </div>
          {rightTab === 'issues' ? (
            <IssuePanel
              selectedGroupId={selectedGroupId}
              selectedIssueId={selectedIssueId}
              selectedIssueVersion={selectedIssueVersion}
              issues={issues}
              agents={agents}
              groupMembers={groupMembers}
              myAgentName={myAgentName}
              setSelectedIssueId={setSelectedIssueId}
              defaultWorkingDir={selectedGroup?.working_dir as string}
              onCreateIssue={handleCreateIssue}
              onCreateCollaboration={handleCreateCollaboration}
            />
          ) : (
            <ArtifactPanel groupId={selectedGroupId} />
          )}
        </div>
      )}
    </div>
  )
}
