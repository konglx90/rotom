import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Issue } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useZenMode } from '../../context/ZenModeContext'
import { useVisitorMode } from '../../context/VisitorContext'
import { extractMentions } from './types'
import { useGroupChatWebSocket } from './useGroupChatWebSocket'
import { pushHistory } from './messageHistory'
import { DirectChatArea } from './DirectChatArea'
import { GroupChatArea } from './GroupChatArea'
import { IssuePanel } from './IssuePanel'
import { ArtifactPanel } from './ArtifactPanel'
import { NotePanel } from './NotePanel'
import { SchedulePanel } from './SchedulePanel'
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
    setDirectTarget,
    openConfigModal,
    loadGroups,
    toggleGroupArchived,
    setGroupMemberWorkingDir,
    clearGroupMemberWorkingDir,
  } = useChatContext()
  const { status: connectionStatus, send, lastIssueChange } = useSocket()
  const { isVisitor, error: visitorError, validate: validateVisitor, token: visitorToken, groupId: visitorResolvedGroupId } = useVisitorMode()

  // Routing
  const selectedGroupId = urlGroupId || ''
  const selectedIssueId = urlIssueId || ''

  const [issues, setIssues] = useState<Issue[]>([])
  const [selectedIssueVersion, setSelectedIssueVersion] = useState(0)
  const [rightTab, setRightTab] = useState<'issues' | 'artifacts' | 'notes' | 'schedules'>('issues')
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)
  const [selfJoinError, setSelfJoinError] = useState<{ groupId: string; message: string } | null>(null)

  // 访客模式：URL 带 ?share=<token> 时,先用 groupId 验 token,失败显示错误页。
  // 重复验证判断看 visitorResolvedGroupId —— validate 成功后 VisitorContext
  // 会把它填上,空则代表还没验过(或已失败)。
  useEffect(() => {
    if (!visitorToken) return
    if (!selectedGroupId) return
    if (visitorResolvedGroupId === selectedGroupId) return
    validateVisitor(selectedGroupId)
  }, [visitorToken, selectedGroupId, visitorResolvedGroupId, validateVisitor])

  // 访客直接访问 /dashboard/groups/:groupId 但 URL 没带 groupId (不应该发生,
  // 防御一下):弹回 /dashboard/agents 让普通引导流程接管。
  useEffect(() => {
    if (visitorToken && !selectedGroupId) {
      navigate('/dashboard/agents', { replace: true })
    }
  }, [visitorToken, selectedGroupId, navigate])

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
    cancelStream,
    getStreamingRequestIdForAgent,
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
  const groupMembers = selectedGroup?.members?.map((m) => m.agent_name) || []

  // --- Handlers ---
  const handleSendMessage = async (text: string) => {
    if (!text || connectionStatus !== 'connected') return

    const trimmed = text
    pushHistory(trimmed)

    if (isDirectMode && selectedGroupId) {
      // 自动中断再发送:同一 agent 还在 streaming 时,先把它的在飞流打断,
      // 否则旧流和新流会乱序到达(worker maxConcurrent 可能允许并发),
      // 视觉上bubble 也会重叠。等 cancel 完成(master→worker 是同步 WS,
      // <50ms)再发新 a2a_send。失败不阻塞 —— cancel 失败只意味着响应方
      // 已经掉线或自然结束,新消息仍可正常发。
      const inFlight = getStreamingRequestIdForAgent(directTarget)
      if (inFlight) {
        await cancelStream(inFlight, directTarget)
      }
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

    // Ensure current user is a group member. The master delivers group stream
    // chunks via broadcastToGroup(groupId, ...) which only reaches agents
    // listed in group_members; if the dashboard user isn't a member, every
    // chunk is silently dropped until a2a_stream_end persists the final text.
    // Awaiting here (not fire-and-forget) is required: the worker may start
    // streaming back before a background addMembers would have committed,
    // losing the live chunks.
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

    // Only treat @name as an @-trigger when name is an actual group member.
    // Non-member @text is left in the message as plain text.
    const memberSet = new Set(groupMembers)
    const mentions = extractMentions(trimmed).filter((name) => memberSet.has(name))
    const targets = mentions.filter((name) => name !== myAgentName)
    const baseRequestId = `grp_${Date.now()}`
    const conversation = {
      type: 'group' as const,
      groupId: selectedGroupId,
      groupName: selectedGroup?.name,
    }

    // 自动中断再发送:每个 @ 的 target,如果它当前正在 streaming(上一轮还没
    // 回完),先把它的在飞流打断,再发新的 a2a_send。串行 await —— 并发 cancel
    // 会让 worker 同时收到多个 abort,虽然能处理但日志会乱。
    for (const target of targets) {
      const inFlight = getStreamingRequestIdForAgent(target)
      if (inFlight) {
        await cancelStream(inFlight, target)
      }
    }

    // Always persist group messages via REST API (single DB insert per
    // message). Without this, when @mentioning multiple agents the Dashboard
    // sends one a2a_send per target, and each a2a_send handler in ws-hub
    // would store the same message N times.
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

  // 重试 self-join。self-join 失败时 banner 上点"重试"会再调 addMembers。
  // 后端在 PR 1 已加兜底 addMembers,所以即便这里失败也不阻塞消息发送。
  const retrySelfJoin = useCallback(async () => {
    if (!selfJoinError) return
    const gid = selfJoinError.groupId
    setSelfJoinError(null)
    try {
      await groupsApi.addMembers(gid, [myAgentName])
      await loadGroups()
    } catch {
      setSelfJoinError({ groupId: gid, message: '入群仍然失败，请刷新页面' })
    }
  }, [selfJoinError, myAgentName, loadGroups])

  const handleArchiveGroup = async (archived: boolean) => {
    if (!selectedGroupId) return
    try {
      await toggleGroupArchived(selectedGroupId, archived)
    } catch (error) {
      console.error('Failed to toggle archived:', error)
    }
  }

  /**
   * Delete the currently active DM. We get the target groupId from
   * localStorage (set by ChatContext.activateDmGroup whenever a DM thread is
   * opened) since `selectedGroupId` is the public-group id and DM rows
   * are filtered out of the sidebar's group list. After deletion, clear
   * the active DM target and navigate back to the empty group page.
   */
  const handleDeleteDm = async () => {
    const dmGroupId = localStorage.getItem('dm_active_group')
    if (!dmGroupId) return
    if (!confirm(`确定删除与 ${directTarget} 的对话吗？该对话的所有消息会被清除。`)) return
    try {
      await groupsApi.delete(dmGroupId)
      localStorage.removeItem('dm_active_group')
      localStorage.removeItem('dm_active_target')
      localStorage.removeItem('group_selected_id')
      setDirectTarget('')
      navigate('/dashboard/groups')
      loadGroups()
    } catch (error) {
      console.error('Failed to delete DM:', error)
      window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleCreateIssue = async (data: {
    description: string
    title?: string
    priority?: string
    assignedTo?: string
  }) => {
    if (!selectedGroupId) return
    try {
      const result = await issuesApi.create(selectedGroupId, {
        description: data.description,
        title: data.title,
        priority: data.priority as any,
        createdBy: myAgentName,
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

  return (
    <div className={`${styles.container} ${zenMode ? styles.containerZen : ''}`}>
      {/* 访客 token 验证失败时,只展示错误页,不要渲染群内容。 */}
      {visitorToken && visitorError && (
        <div className={chatStyles.centerFill}>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔗</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>
              分享链接无效
            </div>
            <div style={{ fontSize: 13, color: '#64748b' }}>
              {visitorError}。请联系分享者重新生成链接。
            </div>
          </div>
        </div>
      )}

      {visitorToken && !visitorError && !isVisitor && (
        <div className={chatStyles.centerFill}>
          <span style={{ color: '#64748b' }}>正在验证分享链接…</span>
        </div>
      )}

      {(!visitorToken || isVisitor) && (
      <>
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
            onCancelStream={cancelStream}
            onNewDmConversation={() => {
              /* sidebar handles new DM creation now */
            }}
            onShowConfig={openConfigModal}

            onDeleteConversation={handleDeleteDm}
          />
        ) : selectedGroup ? (
          <>
            {selfJoinError && selfJoinError.groupId === selectedGroupId && (
              <div className={chatStyles.banner} role="alert">
                <span>{selfJoinError.message}</span>
                <button onClick={retrySelfJoin} className={chatStyles.bannerButton}>
                  重试
                </button>
                <button
                  onClick={() => setSelfJoinError(null)}
                  className={chatStyles.bannerButton}
                  aria-label="忽略"
                >
                  忽略
                </button>
              </div>
            )}
            <GroupChatArea
              selectedGroup={selectedGroup}
              agents={agents}
              myAgentName={myAgentName}
              messages={messages}
              connectionStatus={connectionStatus}
              onSendMessage={handleSendMessage}
              onCancelStream={cancelStream}
              onShowConfig={openConfigModal}
              onAddMembers={() => setShowAddMemberModal(true)}
              onArchiveGroup={handleArchiveGroup}

              onUpdateMemberWorkingDir={async (gid, agentName, dir) => {
                if (dir === null) {
                  await clearGroupMemberWorkingDir(gid, agentName)
                } else {
                  await setGroupMemberWorkingDir(gid, agentName, dir)
                }
              }}
            />
          </>
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
              Artifacts
            </button>
            <button
              className={rightTab === 'notes' ? styles.activeTab : styles.tabBtn}
              onClick={() => setRightTab('notes')}
            >
              Notes
            </button>
            <button
              className={rightTab === 'schedules' ? styles.activeTab : styles.tabBtn}
              onClick={() => setRightTab('schedules')}
            >
              Schedules
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
              onCreateIssue={handleCreateIssue}
              onCreateCollaboration={handleCreateCollaboration}
              readOnly={isVisitor}
            />
          ) : rightTab === 'notes' ? (
            <NotePanel
              selectedGroupId={selectedGroupId}
              myAgentName={myAgentName}
            />
          ) : rightTab === 'schedules' ? (
            <SchedulePanel selectedGroupId={selectedGroupId} />
          ) : (
            <ArtifactPanel groupId={selectedGroupId} />
          )}
        </div>
      )}
      </>
      )}
    </div>
  )
}
