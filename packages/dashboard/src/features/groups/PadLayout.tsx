// pad 模式(≤pad 断点)布局:padToolbar(连接状态/抽屉入口/对话动作)
// + 对话区(renderChatArea(padToolbar))+ 左右抽屉(导航 / 过程 / 产物)。
// 从 GroupChatView.tsx 抽出。padToolbar 内联计算;renderChatArea 由父组件传入。
import { Suspense, lazy, type ReactNode } from 'react'
import type { Agent, Group, Issue } from '../../api/types'
import { AppSidebar } from '../../components/layout/AppSidebar/AppSidebar'
import { Button } from '../../components/ui/Button'
import { IssuePanel } from './IssuePanel'
import { MemoryPanel } from './MemoryPanel'
import { SchedulePanel } from './SchedulePanel'
import type { ProcessTab } from './panelMode'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import styles from './GroupChatView.module.css'

const LazyArtifactPanel = lazy(() => import('./ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })))

type CreateDialog = { kind: 'issue' } | { kind: 'note' } | null

interface PadLayoutProps {
  connectionStatus: ConnectionStatus
  myAgentName: string
  speechEnabled: boolean
  toggleSpeech: () => void
  activeDrawer: 'none' | 'left' | 'right'
  closeDrawer: () => void
  toggleLeft: () => void
  rightDrawerPanel: 'process' | 'artifact'
  toggleRightPanel: (panel: 'process' | 'artifact') => void
  deckOpen: boolean
  toggleDeck: () => void
  isDirectMode: boolean
  handleDeleteDm: () => Promise<void>
  directTargetResolved: string
  selectedGroup: Group | undefined
  isVisitor: boolean
  setShowGroupSettings: (v: boolean) => void
  setShowMemberList: (v: boolean) => void
  setShowAddMemberModal: (v: boolean) => void
  setShowShareModal: (v: boolean) => void
  setShowDebugModal: (v: boolean) => void
  setShowGroupMessagesModal: (v: boolean) => void
  processTab: ProcessTab
  setProcessTab: (t: ProcessTab) => void
  setCreateDialog: (v: CreateDialog) => void
  selectedGroupId: string
  selectedIssueId: string
  setSelectedIssueId: (id: string) => void
  selectedIssueVersion: number
  issues: Issue[]
  agents: Agent[]
  groupMembers: string[]
  handleArtifactClick: (path: string) => void
  artifactSelectedPath: string | null
  setArtifactSelectedPath: (v: string | null) => void
  renderChatArea: (inputToolbar?: ReactNode) => ReactNode
}

export function PadLayout({
  connectionStatus,
  myAgentName,
  speechEnabled,
  toggleSpeech,
  activeDrawer,
  closeDrawer,
  toggleLeft,
  rightDrawerPanel,
  toggleRightPanel,
  deckOpen,
  toggleDeck,
  isDirectMode,
  handleDeleteDm,
  directTargetResolved,
  selectedGroup,
  isVisitor,
  setShowGroupSettings,
  setShowMemberList,
  setShowAddMemberModal,
  setShowShareModal,
  setShowDebugModal,
  setShowGroupMessagesModal,
  processTab,
  setProcessTab,
  setCreateDialog,
  selectedGroupId,
  selectedIssueId,
  setSelectedIssueId,
  selectedIssueVersion,
  issues,
  agents,
  groupMembers,
  handleArtifactClick,
  artifactSelectedPath,
  setArtifactSelectedPath,
  renderChatArea,
}: PadLayoutProps) {
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
  )
}
