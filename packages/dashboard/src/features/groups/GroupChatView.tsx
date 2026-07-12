import { Fragment, useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import { notesApi } from '../../api/notes'
import type { Issue } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useVisitorMode } from '../../context/VisitorContext'
import { useTerminalDeck } from '../terminal/TerminalDeckContext'
import { deriveAgentQueues } from './agentQueue'
import { useGroupChatWebSocket } from './useGroupChatWebSocket'
import { useGroupMessageSender } from './useGroupMessageSender'
import { useSpeechBroadcast } from './useSpeechBroadcast'
import { useResizablePanels } from './_hooks/useResizablePanels'
import {
  PANEL_ORDER,
  MODE_PANELS,
  PANEL_CONFIGS,
  PANEL_MIN_BY_ID,
  PANEL_MODE_KEY,
  PROCESS_TAB_KEY,
  loadPanelMode,
  loadProcessTab,
  type PanelMode,
  type ProcessTab,
} from './panelMode'
import { DirectChatArea } from './DirectChatArea'
import { GroupChatArea } from './GroupChatArea'
import { AppSidebar } from '../../components/layout/AppSidebar/AppSidebar'
import { useIsPad } from '../../hooks/useIsPad'
import { IssuePanel } from './IssuePanel'
const LazyArtifactPanel = lazy(() => import('./ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })))
import { SchedulePanel } from './SchedulePanel'
import { CreateIssueDialog } from './CreateIssueDialog'
import { CreateNoteDialog } from './CreateNoteDialog'
import { AddMemberModal } from './modals/AddMemberModal'
import { MemberListModal } from './modals/MemberListModal'
import { ShareLinkModal } from './ShareLinkModal'
import { GroupMessageStreamModal } from './modals/GroupMessageStreamModal'
import { GroupSettingsModal } from './modals/GroupSettingsModal'
import { MemoryPanel } from './MemoryPanel'
import { ModeSidebarClock } from './ModeSidebarClock'
import { SessionPanel } from './SessionPanel'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import styles from './GroupChatView.module.css'
import chatStyles from './ChatArea.module.css'

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
    loadGroups,
    setGroupMemberWorkingDir,
    clearGroupMemberWorkingDir,
    updateGroupGuidancePrompt,
    updateGroupName,
    updateGroupWorkingDir,
    updateGroupRepo,
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
  const [showMemberList, setShowMemberList] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [showDebugModal, setShowDebugModal] = useState(false)
  const [showGroupMessagesModal, setShowGroupMessagesModal] = useState(false)
  const [showGroupSettings, setShowGroupSettings] = useState(false)
  const [selfJoinError, setSelfJoinError] = useState<{ groupId: string; message: string } | null>(null)
  // 创建对话框状态从 IssuePanel/NotePanel 上移到 process panel 顶部 tabs 行,
  // 让 tabs 行与 chat header 等高对齐。kind 区分走 Issue/协作 还是 Note 流程。
  const [createDialog, setCreateDialog] = useState<
    | { kind: 'issue' }
    | { kind: 'note' }
    | null
  >(null)

  // ── pad 模式(平板/窄屏)抽屉态 ──────────────────────────────────
  // activeDrawer 互斥:同时只能开一个抽屉。开左关右、开右关左。
  // rightDrawerPanel 决定右抽屉显示 process 还是 artifact。
  const isPad = useIsPad()
  const { open: deckOpen, toggle: toggleDeck } = useTerminalDeck()
  const [activeDrawer, setActiveDrawer] = useState<'none' | 'left' | 'right'>('none')
  const [rightDrawerPanel, setRightDrawerPanel] = useState<'process' | 'artifact'>('process')

  const closeDrawer = useCallback(() => setActiveDrawer('none'), [])
  const toggleLeft = useCallback(
    () => setActiveDrawer((d) => (d === 'left' ? 'none' : 'left')),
    [],
  )
  // 工具条右抽屉按钮语义:点当前激活项 → 关;点另一项 → 切过去并保持开。
  const toggleRightPanel = useCallback(
    (panel: 'process' | 'artifact') => {
      setActiveDrawer((d) => {
        if (d === 'right' && rightDrawerPanel === panel) return 'none'
        setRightDrawerPanel(panel)
        return 'right'
      })
    },
    [rightDrawerPanel],
  )

  // Esc 关抽屉。
  useEffect(() => {
    if (!isPad || activeDrawer === 'none') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPad, activeDrawer, closeDrawer])

  // 左抽屉里切群(selectedGroupId 变化)→ 自动收起,露出新对话。
  const padLeftPrevGroupRef = useRef<string>('')
  useEffect(() => {
    if (!isPad) {
      padLeftPrevGroupRef.current = selectedGroupId
      return
    }
    if (
      activeDrawer === 'left' &&
      padLeftPrevGroupRef.current &&
      padLeftPrevGroupRef.current !== selectedGroupId
    ) {
      closeDrawer()
    }
    padLeftPrevGroupRef.current = selectedGroupId
  }, [isPad, activeDrawer, selectedGroupId, closeDrawer])

  // 宽屏恢复时清掉抽屉态,避免残留。
  useEffect(() => {
    if (!isPad && activeDrawer !== 'none') setActiveDrawer('none')
  }, [isPad, activeDrawer])

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

  // --- Derived state (提前到 hook 之前:type='direct' 群没有 directTarget,
  //     需要从 members 推算出对方再传给 useGroupChatWebSocket,否则入站
  //     a2a_message / a2a_stream_chunk / a2a_stream_end 全被空 directTarget 短路,
  //     对方消息只能等刷新拉历史才显示) ---
  const selectedGroup = groups.find((g) => g.id === selectedGroupId)
  // 单聊:老 DM 机制(带 directTarget)或新建的 type='direct' 群。
  // 后者不需要 @,自动把"对方成员"作为 target。
  const isDirectMode = directTarget !== '' || selectedGroup?.type === 'direct'
  const groupMembers = selectedGroup?.members?.map((m) => m.agent_name) || []
  // type='direct' 群没有 directTarget,从 members 里取对方。
  const directTargetResolved = directTarget || groupMembers.find((n) => n !== myAgentName) || ''

  // --- WebSocket hook ---
  const {
    messages,
    setMessages,
    cancelStream,
    turnStartsByAgent,
  } = useGroupChatWebSocket({
    myAgentName,
    selectedGroupId,
    directTarget: directTargetResolved,
  })

  // 语音播报:把当前对话里 agent 返回的正文念出来(像豆包),默认关。
  // speakMessage / speakingId 供每条气泡上的 🔊 手动播放按钮:点哪条念哪条,
  // 与右上角全局开关(自动念每条回复)互相独立。
  const {
    enabled: speechEnabled,
    toggle: toggleSpeech,
    speakMessage,
    speakingId,
  } = useSpeechBroadcast({
    myAgentName,
    selectedGroupId,
  })

  // 推断每个被 @ 的 agent 的待处理队列(processing/queued + 位次),供输入框上方的
  // 队列面板展示。turnStartsByAgent 是 ref,与 messages 变更同步,故以 messages 为依赖
  // 触发重算即可读到最新 turn 起点时刻。DM 模式下传 directTarget(一对一无 @ 标记)。
  const agentQueues = useMemo(
    () => deriveAgentQueues(messages, turnStartsByAgent.current, myAgentName, isDirectMode ? directTargetResolved : undefined),
    [messages, turnStartsByAgent, myAgentName, isDirectMode, directTargetResolved],
  )

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
  // (selectedGroup / isDirectMode / groupMembers / directTargetResolved
  //  已提到 useGroupChatWebSocket 调用之前,见上方注释。)

  // --- Handlers ---
  const handleSendMessage = useGroupMessageSender({
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
  })

  // Reset messages on conversation change.
  // key 只用 selectedGroupId:directTargetResolved 会因 groups 异步加载从 ''
  // 派生为非空,若放进 key 会清掉刚拉到的历史(history effect 依赖不含它,不会重拉)。
  const lastConvKeyRef = useRef<string>('')
  useEffect(() => {
    if (lastConvKeyRef.current && lastConvKeyRef.current !== selectedGroupId) {
      setMessages([])
    }
    lastConvKeyRef.current = selectedGroupId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

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

  const handleDeleteDm = async () => {
    const dmGroupId = localStorage.getItem('dm_active_group')
    if (!dmGroupId) return
    if (!confirm(`确定删除与 ${directTargetResolved} 的对话吗？该对话的所有消息会被清除。`)) return
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

  // 对话区渲染:wide 模式(无工具条)与 pad 模式(带输入框上方工具条)共用。
  // 抽出函数避免两处分支各写一份 chat JSX 导致逻辑漂移。
  const renderChatArea = (inputToolbar?: ReactNode) => (
    <div className={chatStyles.chatArea}>
      {isDirectMode ? (
        <DirectChatArea
          directTarget={directTarget}
          myAgentName={myAgentName}
          messages={messages}
          agents={agents}
          connectionStatus={connectionStatus}
          onSendMessage={handleSendMessage}
          onCancelStream={cancelStream}
          inputToolbar={inputToolbar}
          agentQueues={agentQueues}
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
            onSpeak={speakMessage}
            speakingId={speakingId}
            inputToolbar={inputToolbar}
            agentQueues={agentQueues}
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
  )

  // pad 模式输入框上方工具条(豆包风):开左/右抽屉 + 对话动作入口,可扩展。
  const padToolbar: ReactNode = (
    <div className={styles.padToolbar}>
      {/* 连接状态 dot */}
      <span
        className={`${styles.padStatusDot} ${styles[`modeStatus_${connectionStatus}`]}`}
        title={
          connectionStatus === 'connected' ? `已连接 · ${myAgentName}` :
          connectionStatus === 'connecting' ? '连接中...' :
          connectionStatus === 'conflict' ? '连接冲突' :
          '未连接'
        }
      />
      {/* 语音播报开关(豆包风):把当前对话里 agent 的回复念出来。 */}
      <button
        type="button"
        className={`${styles.padToolBtn} ${speechEnabled ? styles.padToolBtnActive : ''}`}
        onClick={toggleSpeech}
        title={speechEnabled ? '语音播报：开（点击关闭）' : '语音播报：关（点击开启）'}
      >
        {speechEnabled ? '🔊' : '🔈'}
      </button>
      {/* 左抽屉:群列表 / 导航 */}
      <button
        type="button"
        className={`${styles.padToolBtn} ${activeDrawer === 'left' ? styles.padToolBtnActive : ''}`}
        onClick={toggleLeft}
        title="群列表 / 导航"
      >
        ☰
      </button>
      {/* 右抽屉:过程 */}
      <button
        type="button"
        className={`${styles.padToolBtn} ${activeDrawer === 'right' && rightDrawerPanel === 'process' ? styles.padToolBtnActive : ''}`}
        onClick={() => toggleRightPanel('process')}
        title="过程 Issues / 记忆 / 定时任务"
      >
        📋
      </button>
      {/* 右抽屉:产物 */}
      <button
        type="button"
        className={`${styles.padToolBtn} ${activeDrawer === 'right' && rightDrawerPanel === 'artifact' ? styles.padToolBtnActive : ''}`}
        onClick={() => toggleRightPanel('artifact')}
        title="产物 Artifacts"
      >
        📦
      </button>
      {/* 全局终端面板(常驻浮层,切群不断连) */}
      <button
        type="button"
        className={`${styles.padToolBtn} ${deckOpen ? styles.padToolBtnActive : ''}`}
        onClick={toggleDeck}
        title="全局终端面板"
      >
        ⌨
      </button>
      <span className={styles.padToolDivider} />
      {/* 对话动作:沿用 modeSidebar 的 isDirectMode 分支 */}
      {isDirectMode ? (
        <>
          <button
            type="button"
            className={styles.padToolBtn}
            onClick={handleDeleteDm}
            title={`删除与 ${directTargetResolved} 的对话`}
          >
            🗑️
          </button>
        </>
      ) : selectedGroup ? (
        <>
          {!isVisitor && (
            <button
              type="button"
              className={styles.padToolBtn}
              onClick={() => setShowGroupSettings(true)}
              title="群设置(名称/目录/指导/repo)"
            >
              🛠️
            </button>
          )}
          <button
            type="button"
            className={styles.padToolBtn}
            onClick={() => setShowMemberList(true)}
            title="成员"
          >
            👥
          </button>
          {!isVisitor && (
            <button
              type="button"
              className={styles.padToolBtn}
              onClick={() => setShowAddMemberModal(true)}
              title="拉人"
            >
              ➕
            </button>
          )}
          <button
            type="button"
            className={styles.padToolBtn}
            onClick={() => setShowShareModal(true)}
            title="分享"
          >
            🔗
          </button>
          <button
            type="button"
            className={styles.padToolBtn}
            onClick={() => setShowDebugModal(true)}
            title="Sessions 调试"
          >
            🔧
          </button>
          <button
            type="button"
            className={styles.padToolBtn}
            onClick={() => setShowGroupMessagesModal(true)}
            title="当前群消息流"
          >
            💬
          </button>
        </>
      ) : null}
    </div>
  )

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
            key={selectedGroup?.id ?? 'no-group'}
            open={showAddMemberModal}
            groupMemberNames={groupMembers}
            agents={agents}
            onClose={() => setShowAddMemberModal(false)}
            onAdd={handleAddMembers}
          />

          {/* 群模式:成员列表 modal(从原 chatHeader 上移)。
              key=groupId:切群时强制 remount,清空内部 group-scoped state(guidanceValue/editingDir 等),
              否则切群后残留上一群的编辑态。 */}
          {selectedGroup && !isDirectMode && (
            <MemberListModal
              key={selectedGroup.id}
              open={showMemberList}
              members={selectedGroup.members || []}
              agents={agents}
              groupId={selectedGroup.id}
              groupName={selectedGroup.name}
              groupWorkingDir={selectedGroup.working_dir ?? null}
              groupGuidancePrompt={selectedGroup.guidance_prompt ?? null}
              onUpdateGuidancePrompt={updateGroupGuidancePrompt}
              onClose={() => setShowMemberList(false)}
              onUpdateMemberWorkingDir={async (gid, agentName, dir) => {
                if (dir === null) {
                  await clearGroupMemberWorkingDir(gid, agentName)
                } else {
                  await setGroupMemberWorkingDir(gid, agentName, dir)
                }
              }}
              onProfilesChanged={loadGroups}
            />
          )}

          {/* 群模式:分享链接 modal(从原 chatHeader 上移)。 */}
          {showShareModal && selectedGroup && !isDirectMode && (
            <ShareLinkModal
              key={selectedGroup.id}
              open
              groupId={selectedGroup.id}
              groupName={selectedGroup.name}
              onClose={() => setShowShareModal(false)}
            />
          )}

          {/* Sessions 调试 modal:从 ArtifactPanel 底部搬过来,腾出垂直空间。 */}
          {/* 群设置 modal:群聊界面内的群配置入口(名称/工作目录/指导 prompt/内置 repo worktree/技能绑定)。
              复用侧边栏同一组件;update* 回调内部 loadGroups,保存后自动刷新群数据。 */}
          {showGroupSettings && selectedGroup && !isDirectMode && (
            <GroupSettingsModal
              key={selectedGroup.id}
              open
              groupId={selectedGroup.id}
              groupName={selectedGroup.name}
              groupWorkingDir={selectedGroup.working_dir ?? null}
              groupGuidancePrompt={selectedGroup.guidance_prompt ?? null}
              groupRepoUrl={selectedGroup.repo_url ?? null}
              groupRepoDefaultBranch={selectedGroup.repo_default_branch ?? null}
              groupExtraRepos={selectedGroup.extra_repos ?? null}
              groupWorktreeMode={selectedGroup.worktree_mode ?? null}
              memberAgentNames={(selectedGroup.members ?? []).map((m) => m.agent_name)}
              onClose={() => setShowGroupSettings(false)}
              onSaveName={(name) => updateGroupName(selectedGroup.id, name)}
              onSaveWorkingDir={(dir) => updateGroupWorkingDir(selectedGroup.id, dir)}
              onSaveGuidancePrompt={(prompt) => updateGroupGuidancePrompt(selectedGroup.id, prompt)}
              onSaveRepo={(data) => updateGroupRepo(selectedGroup.id, data)}
            />
          )}

          {showDebugModal && selectedGroup && (
            <Modal
              open
              title={`🔧 Sessions · ${selectedGroup.name}`}
              onClose={() => setShowDebugModal(false)}
              size="lg"
            >
              <SessionPanel groupId={selectedGroup.id} />
            </Modal>
          )}

          {/* 当前群消息流 modal:锁定当前群,群不可切换。 */}
          {showGroupMessagesModal && selectedGroup && !isDirectMode && (
            <GroupMessageStreamModal
              open
              groupId={selectedGroup.id}
              groupName={selectedGroup.name}
              groups={groups}
              onClose={() => setShowGroupMessagesModal(false)}
            />
          )}

          {createDialog?.kind === 'issue' && selectedGroupId && (
            <CreateIssueDialog
              open
              agents={agents}
              onClose={() => setCreateDialog(null)}
              onCreateIssue={(data) => {
                handleCreateIssue(data)
                setCreateDialog(null)
              }}
            />
          )}

          {createDialog?.kind === 'note' && selectedGroupId && (
            <CreateNoteDialog
              open
              onClose={() => setCreateDialog(null)}
              onCreate={async (data) => {
                try {
                  await notesApi.create(selectedGroupId, {
                    title: data.title,
                    description: data.description,
                    createdBy: myAgentName,
                  })
                  setCreateDialog(null)
                } catch (err) {
                  console.error('Failed to create note:', err)
                  window.alert(`创建失败：${err instanceof Error ? err.message : String(err)}`)
                }
              }}
            />
          )}

          {/* ── wide 模式(>pad 断点):原 modeSidebar + 双 panel 布局,PC 0 改动 ── */}
          {!isPad && (
            <>
          {/* 最左侧竖列:连接状态 + 布局切换 + 当前对话动作。
              承接原 chatHeader 里的非标题内容(成员/拉人/分享/设置/连接状态),
              让 chat 区域消息直接顶到顶部,最大化纵向空间。 */}
          <div className={styles.modeSidebar}>
            {/* 顶部:连接状态 dot。tooltip 显示完整文案。 */}
            <div
              className={`${styles.modeStatusDot} ${styles[`modeStatus_${connectionStatus}`]}`}
              title={
                connectionStatus === 'connected' ? `已连接 · ${myAgentName}` :
                connectionStatus === 'connecting' ? '连接中...' :
                connectionStatus === 'conflict' ? '连接冲突' :
                '未连接'
              }
            />

            {/* 布局切换:3 选 1,确保主区始终 2 个 panel 同屏。 */}
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

            {/* 语音播报开关(豆包风):把当前对话里 agent 的回复念出来。默认关,
                点击开启 = 用户手势,顺带解锁浏览器语音权限。 */}
            <button
              type="button"
              className={`${styles.modeBtn} ${speechEnabled ? styles.modeBtnActive : ''}`}
              onClick={toggleSpeech}
              title={speechEnabled ? '语音播报：开（点击关闭）' : '语音播报：关（点击开启）'}
            >
              <span className={styles.modeBtnIcons}>{speechEnabled ? '🔊' : '🔈'}</span>
            </button>

            {/* 分隔线:布局切换 与 对话动作 两组按钮之间。 */}
            <div className={styles.modeSidebarDivider} />

            {/* Debug:sessions 弹窗。从 ArtifactPanel 底部移到这里,避免占垂直空间。 */}
            {selectedGroup && (
              <button
                type="button"
                className={styles.modeBtn}
                onClick={() => setShowDebugModal(true)}
                title="Sessions 调试"
              >
                <span className={styles.modeBtnIcons}>{'\u{1F527}'}</span>
              </button>
            )}

            {/* 当前群消息流弹窗:仅群模式,锁定当前群不可切换。 */}
            {selectedGroup && !isDirectMode && (
              <button
                type="button"
                className={styles.modeBtn}
                onClick={() => setShowGroupMessagesModal(true)}
                title="当前群消息流"
              >
                <span className={styles.modeBtnIcons}>{'\u{1F4AC}'}</span>
              </button>
            )}

            {/* 对话动作:按 isDirectMode 切换。Group 模式才显示成员/拉人/分享。 */}
            {isDirectMode ? (
              <>
                <button
                  type="button"
                  className={styles.modeBtn}
                  onClick={handleDeleteDm}
                  title={`删除与 ${directTargetResolved} 的对话`}
                >
                  <span className={styles.modeBtnIcons}>🗑️</span>
                </button>
              </>
            ) : selectedGroup && (
              <>
                {!isVisitor && (
                  <button
                    type="button"
                    className={styles.modeBtn}
                    onClick={() => setShowGroupSettings(true)}
                    title="群设置(名称/目录/指导/repo)"
                  >
                    <span className={styles.modeBtnIcons}>🛠️</span>
                  </button>
                )}
                <button
                  type="button"
                  className={styles.modeBtn}
                  onClick={() => setShowMemberList(true)}
                  title="成员"
                >
                  <span className={styles.modeBtnIcons}>👥</span>
                </button>
                {!isVisitor && (
                  <button
                    type="button"
                    className={styles.modeBtn}
                    onClick={() => setShowAddMemberModal(true)}
                    title="拉人"
                  >
                    <span className={styles.modeBtnIcons}>➕</span>
                  </button>
                )}
                <button
                  type="button"
                  className={styles.modeBtn}
                  onClick={() => setShowShareModal(true)}
                  title="分享"
                >
                  <span className={styles.modeBtnIcons}>🔗</span>
                </button>
              </>
            )}

            {/* 工作时长 + 休息倒计时:推到 modeSidebar 底部,与上方动作按钮留白分隔 */}
            <div className={styles.modeSidebarSpacer} />
            <ModeSidebarClock />
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
                        flex: isLast ? `1 1 ${widths[id]}px` : `0 1 ${widths[id]}px`,
                        minWidth: `${PANEL_MIN_BY_ID[id] ?? 0}px`,
                      }}
                    >
                      {id === 'chat' && renderChatArea()}
                      {id === 'process' && (
                        <div className={styles.processWrap}>
                          <div className={styles.processTabs}>
                            <div className={styles.processTabsLeft}>
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
                                Memory
                              </button>
                              <button
                                type="button"
                                className={`${styles.processTab} ${processTab === 'schedules' ? styles.processTabActive : ''}`}
                                onClick={() => setProcessTab('schedules')}
                              >
                                Schedules
                              </button>
                            </div>
                            {!isVisitor && processTab === 'issues' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCreateDialog({ kind: 'issue' })}
                                className={styles.processCreateBtn}
                              >
                                + 创建
                              </Button>
                            )}
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
                                readOnly={isVisitor}
                                onArtifactClick={handleArtifactClick}
                              />
                            ) : processTab === 'notes' ? (
                              <MemoryPanel
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
            </>
          )}

          {/* ── pad 模式(≤pad 断点):对话区撑满,左右面板收为抽屉 ── */}
          {isPad && (
            <>
              {/* 对话区:工具条(豆包风)渲染在输入框上方 */}
              {renderChatArea(padToolbar)}

              {/* 抽屉遮罩:任一抽屉打开时显示,点击 / 已选中群后自动关闭 */}
              {activeDrawer !== 'none' && (
                <div className={styles.drawerBackdrop} onClick={closeDrawer} />
              )}

              {/* 左抽屉:群列表 / 导航(AppSidebar 抽屉态) */}
              <aside
                className={`${styles.drawerPanel} ${styles.drawerLeft} ${activeDrawer === 'left' ? styles.drawerOpen : ''}`}
                aria-hidden={activeDrawer !== 'left'}
              >
                <button
                  type="button"
                  className={styles.drawerClose}
                  onClick={closeDrawer}
                  title="关闭"
                >
                  ✕
                </button>
                <div className={styles.drawerBody}>
                  <AppSidebar variant="drawer" width={300} onWidthChange={() => {}} />
                </div>
              </aside>

              {/* 右抽屉:过程 / 产物(复用现有 panel 渲染) */}
              <aside
                className={`${styles.drawerPanel} ${styles.drawerRight} ${activeDrawer === 'right' ? styles.drawerOpen : ''}`}
                aria-hidden={activeDrawer !== 'right'}
              >
                <div className={styles.drawerHead}>
                  {rightDrawerPanel === 'process' ? (
                    <div className={styles.processTabs}>
                      <div className={styles.processTabsLeft}>
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
                          Memory
                        </button>
                        <button
                          type="button"
                          className={`${styles.processTab} ${processTab === 'schedules' ? styles.processTabActive : ''}`}
                          onClick={() => setProcessTab('schedules')}
                        >
                          Schedules
                        </button>
                      </div>
                      {!isVisitor && processTab === 'issues' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCreateDialog({ kind: 'issue' })}
                          className={styles.processCreateBtn}
                        >
                          + 创建
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className={styles.drawerTitle}>📦 Artifacts</span>
                  )}
                  <button
                    type="button"
                    className={styles.drawerClose}
                    onClick={closeDrawer}
                    title="关闭"
                  >
                    ✕
                  </button>
                </div>
                <div className={styles.drawerBody}>
                  {rightDrawerPanel === 'process' ? (
                    !selectedGroup ? (
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
                        readOnly={isVisitor}
                        onArtifactClick={handleArtifactClick}
                      />
                    ) : processTab === 'notes' ? (
                      <MemoryPanel
                        selectedGroupId={selectedGroupId}
                        myAgentName={myAgentName}
                      />
                    ) : (
                      <SchedulePanel selectedGroupId={selectedGroupId} />
                    )
                  ) : selectedGroup ? (
                    <Suspense fallback={<div className={styles.panelPlaceholder}>加载中...</div>}>
                      <LazyArtifactPanel
                        groupId={selectedGroupId}
                        selectedPath={artifactSelectedPath}
                        onSelectedPathChange={setArtifactSelectedPath}
                      />
                    </Suspense>
                  ) : (
                    <div className={styles.panelPlaceholder}>选择群后查看 Artifacts</div>
                  )}
                </div>
              </aside>
            </>
          )}
        </div>
      )}
    </div>
  )
}
