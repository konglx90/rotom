// wide 模式(>pad 断点)布局:modeSidebar(连接状态/布局切换/对话动作/时钟)
// + 双 panel 布局(chat / process / artifact)。从 GroupChatView.tsx 抽出。
// visibleOrder 由 mode 派生(内部计算)。renderChatArea 由父组件传入(与 pad 共用)。
import { Fragment, Suspense, lazy, type ReactNode } from 'react'
import type { Agent, Group, Issue } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { IssuePanel } from './IssuePanel'
import { MemoryPanel } from './MemoryPanel'
import { SchedulePanel } from './SchedulePanel'
import { ModeSidebarClock } from './ModeSidebarClock'
import {
  PANEL_ORDER,
  MODE_PANELS,
  PANEL_MIN_BY_ID,
  type PanelMode,
  type ProcessTab,
} from './panelMode'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import styles from './GroupChatView.module.css'

const LazyArtifactPanel = lazy(() => import('./ArtifactPanel').then((m) => ({ default: m.ArtifactPanel })))

type CreateDialog = { kind: 'issue' } | { kind: 'note' } | null

interface WideLayoutProps {
  connectionStatus: ConnectionStatus
  myAgentName: string
  mode: PanelMode
  setMode: (m: PanelMode) => void
  speechEnabled: boolean
  toggleSpeech: () => void
  selectedGroup: Group | undefined
  isDirectMode: boolean
  isVisitor: boolean
  handleDeleteDm: () => Promise<void>
  directTargetResolved: string
  setShowDebugModal: (v: boolean) => void
  setShowGroupMessagesModal: (v: boolean) => void
  setShowGroupSettings: (v: boolean) => void
  setShowMemberList: (v: boolean) => void
  setShowAddMemberModal: (v: boolean) => void
  setShowShareModal: (v: boolean) => void
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
  widths: Record<string, number>
  onSplitterMouseDown: (leftId: string, rightId: string) => (e: React.MouseEvent) => void
}

export function WideLayout({
  connectionStatus,
  myAgentName,
  mode,
  setMode,
  speechEnabled,
  toggleSpeech,
  selectedGroup,
  isDirectMode,
  isVisitor,
  handleDeleteDm,
  directTargetResolved,
  setShowDebugModal,
  setShowGroupMessagesModal,
  setShowGroupSettings,
  setShowMemberList,
  setShowAddMemberModal,
  setShowShareModal,
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
  widths,
  onSplitterMouseDown,
}: WideLayoutProps) {
  const activePanels = MODE_PANELS[mode]
  const visibleOrder = PANEL_ORDER.filter((id) => activePanels.includes(id))

  return (
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
  )
}
