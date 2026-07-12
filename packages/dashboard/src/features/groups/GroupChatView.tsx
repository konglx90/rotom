import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { Issue } from '../../api/types'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'
import { useVisitorMode } from '../../context/VisitorContext'
import { useTerminalDeck } from '../terminal/TerminalDeckContext'
import { deriveAgentQueues } from './agentQueue'
import { useGroupChatWebSocket } from './useGroupChatWebSocket'
import { useGroupMessageSender } from './useGroupMessageSender'
import { useGroupActions } from './useGroupActions'
import { GroupChatModals } from './GroupChatModals'
import { WideLayout } from './WideLayout'
import { PadLayout } from './PadLayout'
import { useSpeechBroadcast } from './useSpeechBroadcast'
import { useResizablePanels } from './_hooks/useResizablePanels'
import {
  PANEL_CONFIGS,
  PANEL_MODE_KEY,
  PROCESS_TAB_KEY,
  loadPanelMode,
  loadProcessTab,
  type PanelMode,
  type ProcessTab,
} from './panelMode'
import { DirectChatArea } from './DirectChatArea'
import { GroupChatArea } from './GroupChatArea'
import { useIsPad } from '../../hooks/useIsPad'
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

  // --- Handlers (loadIssues + 群动作 + 两个用到 loadIssues 的 effect) ---
  const {
    handleAddMembers,
    retrySelfJoin,
    handleDeleteDm,
    handleCreateIssue,
    handleArtifactClick,
  } = useGroupActions({
    selectedGroupId,
    myAgentName,
    directTargetResolved,
    selfJoinError,
    setSelfJoinError,
    setDirectTarget,
    setArtifactSelectedPath,
    setMode,
    setShowAddMemberModal,
    setIssues,
    setSelectedIssueId,
    setSelectedIssueVersion,
    loadGroups,
    navigate,
    lastIssueChange,
    selectedIssueId,
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
          <GroupChatModals
            selectedGroup={selectedGroup}
            selectedGroupId={selectedGroupId}
            isDirectMode={isDirectMode}
            groupMembers={groupMembers}
            agents={agents}
            groups={groups}
            myAgentName={myAgentName}
            showAddMemberModal={showAddMemberModal}
            setShowAddMemberModal={setShowAddMemberModal}
            showMemberList={showMemberList}
            setShowMemberList={setShowMemberList}
            showShareModal={showShareModal}
            setShowShareModal={setShowShareModal}
            showGroupSettings={showGroupSettings}
            setShowGroupSettings={setShowGroupSettings}
            showDebugModal={showDebugModal}
            setShowDebugModal={setShowDebugModal}
            showGroupMessagesModal={showGroupMessagesModal}
            setShowGroupMessagesModal={setShowGroupMessagesModal}
            createDialog={createDialog}
            setCreateDialog={setCreateDialog}
            handleAddMembers={handleAddMembers}
            handleCreateIssue={handleCreateIssue}
            updateGroupGuidancePrompt={updateGroupGuidancePrompt}
            updateGroupName={updateGroupName}
            updateGroupWorkingDir={updateGroupWorkingDir}
            updateGroupRepo={updateGroupRepo}
            setGroupMemberWorkingDir={setGroupMemberWorkingDir}
            clearGroupMemberWorkingDir={clearGroupMemberWorkingDir}
            loadGroups={loadGroups}
          />

          {/* ── wide 模式(>pad 断点):原 modeSidebar + 双 panel 布局,PC 0 改动 ── */}
          {!isPad && (
            <WideLayout
              connectionStatus={connectionStatus}
              myAgentName={myAgentName}
              mode={mode}
              setMode={setMode}
              speechEnabled={speechEnabled}
              toggleSpeech={toggleSpeech}
              selectedGroup={selectedGroup}
              isDirectMode={isDirectMode}
              isVisitor={isVisitor}
              handleDeleteDm={handleDeleteDm}
              directTargetResolved={directTargetResolved}
              setShowDebugModal={setShowDebugModal}
              setShowGroupMessagesModal={setShowGroupMessagesModal}
              setShowGroupSettings={setShowGroupSettings}
              setShowMemberList={setShowMemberList}
              setShowAddMemberModal={setShowAddMemberModal}
              setShowShareModal={setShowShareModal}
              processTab={processTab}
              setProcessTab={setProcessTab}
              setCreateDialog={setCreateDialog}
              selectedGroupId={selectedGroupId}
              selectedIssueId={selectedIssueId}
              setSelectedIssueId={setSelectedIssueId}
              selectedIssueVersion={selectedIssueVersion}
              issues={issues}
              agents={agents}
              groupMembers={groupMembers}
              handleArtifactClick={handleArtifactClick}
              artifactSelectedPath={artifactSelectedPath}
              setArtifactSelectedPath={setArtifactSelectedPath}
              renderChatArea={renderChatArea}
              widths={widths}
              onSplitterMouseDown={onSplitterMouseDown}
            />
          )}

          {/* ── pad 模式(≤pad 断点):对话区撑满,左右面板收为抽屉 ── */}
          {isPad && (
            <PadLayout
              connectionStatus={connectionStatus}
              myAgentName={myAgentName}
              speechEnabled={speechEnabled}
              toggleSpeech={toggleSpeech}
              activeDrawer={activeDrawer}
              closeDrawer={closeDrawer}
              toggleLeft={toggleLeft}
              rightDrawerPanel={rightDrawerPanel}
              toggleRightPanel={toggleRightPanel}
              deckOpen={deckOpen}
              toggleDeck={toggleDeck}
              isDirectMode={isDirectMode}
              handleDeleteDm={handleDeleteDm}
              directTargetResolved={directTargetResolved}
              selectedGroup={selectedGroup}
              isVisitor={isVisitor}
              setShowGroupSettings={setShowGroupSettings}
              setShowMemberList={setShowMemberList}
              setShowAddMemberModal={setShowAddMemberModal}
              setShowShareModal={setShowShareModal}
              setShowDebugModal={setShowDebugModal}
              setShowGroupMessagesModal={setShowGroupMessagesModal}
              processTab={processTab}
              setProcessTab={setProcessTab}
              setCreateDialog={setCreateDialog}
              selectedGroupId={selectedGroupId}
              selectedIssueId={selectedIssueId}
              setSelectedIssueId={setSelectedIssueId}
              selectedIssueVersion={selectedIssueVersion}
              issues={issues}
              agents={agents}
              groupMembers={groupMembers}
              handleArtifactClick={handleArtifactClick}
              artifactSelectedPath={artifactSelectedPath}
              setArtifactSelectedPath={setArtifactSelectedPath}
              renderChatArea={renderChatArea}
            />
          )}
        </div>
      )}
    </div>
  )
}
