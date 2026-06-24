import { Fragment, useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Issue } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useVisitorMode } from '../../context/VisitorContext'
import { extractMentions } from './types'
import { useGroupChatWebSocket } from './useGroupChatWebSocket'
import { useResizablePanels } from './_hooks/useResizablePanels'
import type { PanelConfig } from './_hooks/useResizablePanels'
import { pushHistory } from './messageHistory'
import { DirectChatArea } from './DirectChatArea'
import { GroupChatArea } from './GroupChatArea'
import { IssuePanel } from './IssuePanel'
const LazyArtifactPanel = lazy(() => import('./ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })))
import { NotePanel } from './NotePanel'
import { SchedulePanel } from './SchedulePanel'
import { AddMemberModal } from './modals/AddMemberModal'
import styles from './GroupChatView.module.css'
import chatStyles from './ChatArea.module.css'

// 主面板布局:三类顶级 panel —— chat / process / artifact。
//   - chat: 对话区
//   - process: 过程区,内部 sub-tab 切 Issues/Notes/定时任务(Issues 为主)
//   - artifact: 产物区
//
// 显示规则:固定 3 种组合模式,toolbar 切换,确保主区始终 2 个 panel 同屏。
//   - chat+process(默认):对话 + 过程
//   - chat+artifact:对话 + 产物
//   - process+artifact:过程 + 产物
type PanelId = 'chat' | 'process' | 'artifact'
type PanelMode = 'chat-process' | 'chat-artifact' | 'process-artifact'
type ProcessTab = 'issues' | 'notes' | 'schedules'

const PANEL_ORDER: PanelId[] = ['chat', 'process', 'artifact']
const MODE_PANELS: Record<PanelMode, PanelId[]> = {
  'chat-process': ['chat', 'process'],
  'chat-artifact': ['chat', 'artifact'],
  'process-artifact': ['process', 'artifact'],
}
const PANEL_CONFIGS: PanelConfig[] = [
  { id: 'chat', width: 720, min: 360 },
  { id: 'process', width: 480, min: 320 },
  { id: 'artifact', width: 560, min: 360 },
]
const PANEL_MODE_KEY = 'rotom-panel-mode'
const PROCESS_TAB_KEY = 'rotom-process-tab'

function loadPanelMode(): PanelMode {
  try {
    const raw = localStorage.getItem(PANEL_MODE_KEY)
    if (raw === 'chat-process' || raw === 'chat-artifact' || raw === 'process-artifact') return raw
    return 'chat-process'
  } catch {
    return 'chat-process'
  }
}

function loadProcessTab(): ProcessTab {
  try {
    const raw = localStorage.getItem(PROCESS_TAB_KEY)
    if (raw === 'issues' || raw === 'notes' || raw === 'schedules') return raw
    return 'issues'
  } catch {
    return 'issues'
  }
}

export function GroupChatView() {
  const navigate = useNavigate()
  const { groupId: urlGroupId, issueId: urlIssueId } = useParams<{
    groupId?: string
    issueId?: string
  }>()
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
  // mode:当前布局模式(3 选 1),确保主区始终 2 个 panel 同屏。
  // activePanels:由 mode 派生,不再独立 toggle。
  // processTab:process panel 内部 sub-tab 切换 Issues/Notes/定时任务。
  // artifactSelectedPath:Issue 详情点击 artifact 路径 → 联动 ArtifactPanel 选中。
  const [mode, setMode] = useState<PanelMode>(loadPanelMode)
  const [processTab, setProcessTab] = useState<ProcessTab>(loadProcessTab)
  const { widths, onSplitterMouseDown } = useResizablePanels('rotom-panel-widths', PANEL_CONFIGS)
  const [artifactSelectedPath, setArtifactSelectedPath] = useState<string | null>(null)
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)
  const [selfJoinError, setSelfJoinError] = useState<{ groupId: string; message: string } | null>(null)

  const activePanels = MODE_PANELS[mode]

  // 访客模式：URL 带 ?share=<token> 时,先用 groupId 验 token,失败显示错误页。
  useEffect(() => {
    if (!visitorToken) return
    if (!selectedGroupId) return
    if (visitorResolvedGroupId === selectedGroupId) return
    validateVisitor(selectedGroupId)
  }, [visitorToken, selectedGroupId, visitorResolvedGroupId, validateVisitor])

  // 访客直接访问 /dashboard/groups/:groupId 但 URL 没带 groupId:
  // 弹回 /dashboard/agents 让普通引导流程接管。
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

  // React to global socket pushes.
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

    for (const target of targets) {
      const inFlight = getStreamingRequestIdForAgent(target)
      if (inFlight) {
        await cancelStream(inFlight, target)
      }
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

  // Reset messages on conversation change.
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

  // activePanels / processTab 持久化。widths 由 useResizablePanels 单独管。
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_MODE_KEY, mode)
    } catch {
      /* ignore */
    }
  }, [mode])

  useEffect(() => {
    try {
      localStorage.setItem(PROCESS_TAB_KEY, processTab)
    } catch {
      /* ignore */
    }
  }, [processTab])

  // Issue 详情点击 artifact 路径 → 切到含 artifact 的模式(优先保留 process)。
  // 当前是 chat-process → 切到 process-artifact;当前是 chat-artifact 不变;
  // 当前是 process-artifact 不变。
  const handleArtifactClick = useCallback((path: string) => {
    setArtifactSelectedPath(path)
    setMode(prev => {
      if (prev === 'chat-artifact' || prev === 'process-artifact') return prev
      return 'process-artifact'
    })
  }, [])

  const visibleOrder = PANEL_ORDER.filter(id => activePanels.includes(id))

  return (
    <div className={styles.container}>
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
        <div className={styles.workspace}>
          <AddMemberModal
            open={showAddMemberModal}
            groupMemberNames={groupMembers}
            agents={agents}
            onClose={() => setShowAddMemberModal(false)}
            onAdd={handleAddMembers}
          />

          {/* 最左侧 mode 切换条:垂直窄条,3 种布局模式。
              放这里(而不是顶部)是为了让 panelsRow(尤其 chat)顶部不被
              toolbar 占用,高度最大化。 */}
          <div className={styles.modeSidebar}>
            <button
              type="button"
              className={`${styles.modeBtn} ${mode === 'chat-process' ? styles.modeBtnActive : ''}`}
              onClick={() => setMode('chat-process')}
              title="对话 + 过程(Issues/Notes/定时任务)"
            >
              <span className={styles.modeBtnIcons}>💬<br/>📋</span>
            </button>
            <button
              type="button"
              className={`${styles.modeBtn} ${mode === 'chat-artifact' ? styles.modeBtnActive : ''}`}
              onClick={() => setMode('chat-artifact')}
              title="对话 + Artifacts"
            >
              <span className={styles.modeBtnIcons}>💬<br/>📦</span>
            </button>
            <button
              type="button"
              className={`${styles.modeBtn} ${mode === 'process-artifact' ? styles.modeBtnActive : ''}`}
              onClick={() => setMode('process-artifact')}
              title="过程 + Artifacts"
            >
              <span className={styles.modeBtnIcons}>📋<br/>📦</span>
            </button>
          </div>

          {/* 主区:2 个 panel + 1 条 splitter */}
          <div className={styles.panelsRow}>
            {visibleOrder.length === 0 ? (
              <div className={styles.panelsEmpty}>所有面板已隐藏,点击顶部按钮恢复</div>
            ) : (
              visibleOrder.map((id, idx) => {
                const prev = visibleOrder[idx - 1]
                // 最后一个 visible panel 用 flex:1 占满剩余空间,避免右侧留白。
                // flex-basis 仍是 widths[id],splitter 拖拽时持久化的 widths 正常;
                // 视觉上该 panel 在 widths 基础上自动 grow 填满容器。
                const isLast = idx === visibleOrder.length - 1
                return (
                  <Fragment key={id}>
                    {idx > 0 && prev && (
                      <div
                        className={styles.splitter}
                        onMouseDown={onSplitterMouseDown(prev, id)}
                        title="拖拽调整宽度"
                      />
                    )}
                    <div
                      className={styles.panel}
                      style={{
                        width: `${widths[id]}px`,
                        flex: isLast ? `1 1 ${widths[id]}px` : `0 0 ${widths[id]}px`,
                      }}
                    >
                      {id === 'chat' && (
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
                      )}
                      {id === 'process' && (
                        <div className={styles.processWrap}>
                          <div className={styles.processTabs}>
                            <button
                              type="button"
                              className={`${styles.processTab} ${processTab === 'issues' ? styles.processTabActive : ''}`}
                              onClick={() => setProcessTab('issues')}
                            >
                              Issues
                            </button>
                            <button
                              type="button"
                              className={`${styles.processTab} ${processTab === 'notes' ? styles.processTabActive : ''}`}
                              onClick={() => setProcessTab('notes')}
                            >
                              Notes
                            </button>
                            <button
                              type="button"
                              className={`${styles.processTab} ${processTab === 'schedules' ? styles.processTabActive : ''}`}
                              onClick={() => setProcessTab('schedules')}
                            >
                              定时任务
                            </button>
                          </div>
                          <div className={styles.processBody}>
                            {!selectedGroup ? (
                              <div className={styles.panelPlaceholder}>选择群后查看过程</div>
                            ) : processTab === 'issues' ? (
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
                                onArtifactClick={handleArtifactClick}
                              />
                            ) : processTab === 'notes' ? (
                              <NotePanel
                                selectedGroupId={selectedGroupId}
                                myAgentName={myAgentName}
                              />
                            ) : (
                              <SchedulePanel selectedGroupId={selectedGroupId} />
                            )}
                          </div>
                        </div>
                      )}
                      {id === 'artifact' && (
                        selectedGroup ? (
                          <Suspense fallback={<div className={styles.panelPlaceholder}>加载中...</div>}>
                            <LazyArtifactPanel
                              groupId={selectedGroupId}
                              selectedPath={artifactSelectedPath}
                              onSelectedPathChange={setArtifactSelectedPath}
                            />
                          </Suspense>
                        ) : (
                          <div className={styles.panelPlaceholder}>选择群后查看 Artifacts</div>
                        )
                      )}
                    </div>
                  </Fragment>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
