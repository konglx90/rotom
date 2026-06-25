import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { issuesApi, type IssueMessage } from '../../../api/issues'
import type { Agent, Issue, IssueEvent } from '../../../api/types'
import { AsyncBoundary } from '../../../components/data/AsyncBoundary'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import shared from './_shared.module.css'
import styles from './IssueDetail.module.css'
import { CollaborationMessages } from './CollaborationMessages'
import { ContinueInputBar } from './ContinueInputBar'
import { FooterHint } from './FooterHint'
import { IssueDetailHeader } from './IssueDetailHeader'
import { IssueEditForm } from './IssueEditForm'
import { IssueEventsTimeline } from './IssueEventsTimeline'
import { PendingApprovalsBar } from './PendingApprovalsBar'
import { WorkerTodosPanel } from './WorkerTodosPanel'
import { useIssueData } from './useIssueData'
import { useIssueEdit } from './useIssueEdit'
import { displayDescription } from '../createIssueTitle'

interface IssueDetailProps {
  issueId: string
  /** Bumped by parent whenever Master pushes issue_changed for this issueId.
   *  Triggers a refetch in lieu of polling. */
  refreshSignal?: number
  agents: Agent[]
  groupMembers: string[]
  onBack?: () => void
  /** 单页路由(IssueDetailPage)使用时打开,把底部 dock 改为 position:fixed
   *  贴在视口底,并给 body 补等高的 padding-bottom,避免遮挡内容。
   *  IssuePanel 嵌入态保持原 flex 列内排版。 */
  standalone?: boolean
  /** 访客模式:隐藏所有写操作(状态切换、中断、完成、取消、删除、续跑、评论)。 */
  readOnly?: boolean
  /** 点击产物文件路径时的回调。嵌入态由 GroupChatView 接管,把 ArtifactPanel
   *  切换到可见并选中该文件;standalone 态由 IssueDetailPage 弹出抽屉预览。
   *  不传时产物列表维持只读展示(不做点击)。 */
  onArtifactClick?: (path: string) => void
}

export function IssueDetail({ issueId, refreshSignal, agents, groupMembers, onBack, standalone = false, readOnly = false, onArtifactClick }: IssueDetailProps) {
  const { issue, events, messages, loading, reload } = useIssueData(issueId, refreshSignal)
  const edit = useIssueEdit(issue, reload)

  return (
    <AsyncBoundary
      data={issue}
      loading={loading}
      emptyFallback={<div className={styles.issueEmpty}>Issue 未找到</div>}
      loadingFallback={<div className={styles.issueEmpty}>加载中...</div>}
    >
      {(data) => (
        <IssueDetailBody
          issue={data}
          events={events}
          messages={messages}
          edit={edit}
          reload={reload}
          issueId={issueId}
          agents={agents}
          groupMembers={groupMembers}
          onBack={onBack}
          standalone={standalone}
          readOnly={readOnly}
          onArtifactClick={onArtifactClick}
        />
      )}
    </AsyncBoundary>
  )
}

interface IssueDetailBodyProps {
  issue: Issue
  events: IssueEvent[]
  messages: IssueMessage[]
  edit: ReturnType<typeof useIssueEdit>
  reload: () => Promise<void>
  issueId: string
  agents: Agent[]
  groupMembers: string[]
  onBack?: () => void
  standalone: boolean
  readOnly: boolean
  onArtifactClick?: (path: string) => void
}

function IssueDetailBody({
  issue,
  events,
  messages,
  edit,
  reload,
  issueId,
  agents,
  groupMembers,
  onBack,
  standalone,
  readOnly,
  onArtifactClick,
}: IssueDetailBodyProps) {
  // in_progress 期间用户已发送但 worker 还没消费的追加指令(chip 列表)。
  // 提升到 IssueDetail 层,让 ContinueInputBar(push)和 IssueDetailHeader
  // (中断时 flush + clear)都能访问。issue 翻终态时按下面 effect 处理。
  const [pendingQueue, setPendingQueue] = useState<string[]>([])
  const prevStatusRef = useRef<Issue['status'] | undefined>(undefined)
  // pendingQueue 的 ref 副本:status 变化 effect 只在 issue?.status 改变时跑,
  // 但 effect 里要读「用户最后一次加 chip 后」的最新队列。直接把 pendingQueue
  // 放 effect 依赖会让每次 push/remove 都重跑(还要先于本 effect 把 ref 置空,
  // 否则 reload 触发的二次渲染可能重入),所以走 ref 同步。
  const pendingQueueRef = useRef<string[]>([])
  pendingQueueRef.current = pendingQueue

  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = issue?.status
    if (!issue) return
    // 离开 in_progress 时处理本地草稿:
    //   - completed/failed(worker 自然跑完)→ 自动 /continue,worker 用
    //     session_id --resume 起新轮。对齐 codex CLI "steers persist across
    //     rounds" 语义:用户加了 chip 但没按 ESC,草稿也不丢。
    //   - paused → 自动 /append(worker idle 分支同样 --resume 起新轮)。
    //   - cancelled / 回 open → 丢弃草稿。
    // ESC 路径不在这里:handleInterrupt 自己 flush + /interrupt,queue 非空
    // 时 worker 会续跑保持 in_progress,本 effect 不会触发。
    if (prev === 'in_progress' && issue.status !== 'in_progress') {
      const queued = pendingQueueRef.current
      // 先清本地 chip + ref,避免 reload 期间旧 chip 闪一帧 / effect 重入。
      setPendingQueue([])
      pendingQueueRef.current = []
      if (queued.length === 0) return

      const merged = queued.join('\n\n')
      if (issue.status === 'completed' || issue.status === 'failed') {
        void issuesApi
          .continue(issue.id, merged, issue.created_by)
          .then(() => reload())
          .catch(err => console.error('Failed to auto-continue pending drafts:', err))
      } else if (issue.status === 'paused') {
        void issuesApi
          .append(issue.id, merged, issue.created_by)
          .then(() => reload())
          .catch(err => console.error('Failed to auto-append pending drafts:', err))
      }
      // cancelled:丢弃(已 setPendingQueue([]))
    }
  }, [issue?.status])

  const pushPending = useCallback((text: string) => {
    setPendingQueue(q => [...q, text])
  }, [])
  const removePending = useCallback((idx: number) => {
    setPendingQueue(q => q.filter((_, i) => i !== idx))
  }, [])
  const clearPending = useCallback(() => setPendingQueue([]), [])

  // 把所有 status='pending' 的 approval_request 提取出来,渲染成悬浮在底部
  // 按钮上方的快捷确认条。信息流里的 ApprovalCard 同步保留,既能看到上下文
  // 也能用其两阶段 deny 输入完整 feedback。
  const pendingApprovals = useMemo(() => {
    return events.filter(ev => {
      if (ev.event_type !== 'approval_request') return false
      try {
        const m = JSON.parse(ev.metadata || '{}') as Record<string, unknown>
        return (m.status ?? 'pending') === 'pending'
      } catch { return false }
    })
  }, [events])

  // 滚动:把 .issueBody(overflow-y:auto 的真正滚动容器)的 scrollTop 拉到底。
  // RO 监听 content 高度变化触发滚动;input 显式调用 scrollToBottom 兜底
  // (append 不一定改变 content 高度,但用户期望视线回到底部)。
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // standalone 模式下,dock 脱离文档流(position:fixed),需要测它的实时高度,
  // 用作 .issueBody 的 paddingBottom,避免最后几条消息被遮在 dock 下面。
  const dockRef = useRef<HTMLDivElement>(null)
  const [dockHeight, setDockHeight] = useState(0)

  const scrollToBottom = useCallback(() => {
    // 双 rAF 等 React commit + 浏览器 layout 完成,再把滚动容器拉到底。
    // 直接写 scrollTop = scrollHeight 比 scrollIntoView 准:sentinel 是零高度,
    // block:'end' 只对齐它的下边沿,会差一点点。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const body = bodyRef.current
        if (body) body.scrollTop = body.scrollHeight
      })
    })
  }, [])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => scrollToBottom())
    ro.observe(content)
    scrollToBottom()
    return () => ro.disconnect()
  }, [scrollToBottom])

  // standalone 下持续测 dock 高度;非 standalone 时直接清零(不占空间)。
  // 依赖里必须包含 issue?.status:首屏 loading 阶段组件 early return,dockRef 是 null,
  // effect 跑一次拿不到节点就退出;等数据到达 issue 从 undefined 变成实际对象,
  // 此时才需要重新跑 effect 去 observe 真实挂载的 dock。pendingApprovals.length
  // 覆盖确认条/输入栏切换分支。
  useEffect(() => {
    if (!standalone) { setDockHeight(0); return }
    const dock = dockRef.current
    if (!dock) { setDockHeight(0); return }
    const measure = () => setDockHeight(dock.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(dock)
    return () => ro.disconnect()
  }, [standalone, pendingApprovals.length, issue?.status])

  const handleSubmitted = useCallback(async () => {
    await reload()
    scrollToBottom()
  }, [reload, scrollToBottom])

  const artifacts: string[] = (() => {
    try { return JSON.parse(issue.artifacts || '[]') } catch { return [] }
  })()

  // 续聊只在 issue 已结束(成功或失败)时显示;cancelled 不允许续(用户主动放弃)。
  const showInputBar = issue.status !== 'cancelled'

  const handleCancel = async () => {
    if (!confirm('确定要取消这个 Issue 吗？')) return
    try {
      await issuesApi.cancel(issue.id, issue.created_by)
      await reload()
    } catch (err) {
      console.error('Failed to cancel issue:', err)
    }
  }

  const handleDelete = async () => {
    if (!confirm('确定要删除这个 Issue 吗？此操作不可恢复。')) return
    try {
      await issuesApi.delete(issue.id)
      onBack?.()
    } catch (err) {
      console.error('Failed to delete issue:', err)
    }
  }

  const handleComplete = async () => {
    if (!confirm('确定将此 Issue 标记为已完成吗？')) return
    try {
      await issuesApi.complete(issue.id, issue.created_by)
      await reload()
    } catch (err) {
      console.error('Failed to complete issue:', err)
    }
  }

  return (
    <div className={styles.issueDetail}>
      <IssueDetailHeader
        issue={issue}
        agents={agents}
        groupMembers={groupMembers}
        onBack={onBack}
        edit={edit}
        reload={reload}
        onComplete={handleComplete}
        onCancel={handleCancel}
        onDelete={handleDelete}
        onInterrupted={clearPending}
        pendingQueue={pendingQueue}
        readOnly={readOnly}
      />

      <div
        ref={bodyRef}
        className={styles.issueBody}
        style={standalone && dockHeight ? { paddingBottom: dockHeight } : undefined}
      >
        <div ref={contentRef}>
          {edit.editing ? (
            <IssueEditForm edit={edit} />
          ) : (
            issue.description && (
              <div className={styles.issueDescription}>
                <MarkdownContent content={displayDescription(issue)} />
              </div>
            )
          )}

          {issue.latest_todos && issue.latest_todos.length > 0 && (
            <WorkerTodosPanel
              todos={issue.latest_todos}
              agentName={issue.assigned_to || ''}
              active={issue.status === 'in_progress' || issue.status === 'paused'}
            />
          )}

          <IssueEventsTimeline
            events={events}
            issueId={issueId}
            inProgress={issue.status === 'in_progress'}
            onApprovalResolved={reload}
          />

          {issue.type === 'collaboration' && (
            <CollaborationMessages messages={messages} maxRounds={issue.max_rounds} />
          )}

          {artifacts.length > 0 && (
            <div className={shared.artifactsSection}>
              <div className={shared.artifactsTitle}>产物 ({artifacts.length})</div>
              {artifacts.map((a, i) => (
                <a
                  key={i}
                  className={styles.artifactItem}
                  onClick={() => onArtifactClick?.(a)}
                  title={onArtifactClick ? `点击在 Artifacts 中查看: ${a}` : a}
                >
                  {a}
                </a>
              ))}
            </div>
          )}

          {issue.result && (
            <div className={shared.artifactsSection}>
              <div className={shared.artifactsTitle}>{issue.type === 'review' ? '评审报告' : '执行结果'}</div>
              <div className={styles.issueDescription}>
                <MarkdownContent content={issue.result} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 底部互斥区:有待确认时由 PendingApprovalsBar 短暂替换输入栏(对齐 Claude Code CLI
          的「正常输入 → 选项确认 → 回到输入」交互)。cancelled 终态下两者都不渲染。
          访客模式下两者都不渲染 —— 访客不能 approve 也不能续跑。 */}
      {!readOnly && (pendingApprovals.length > 0 ? (
        <div
          ref={dockRef}
          className={`${styles.bottomDock} ${standalone ? styles.bottomDockFixed : ''}`}
        >
          <PendingApprovalsBar
            issueId={issueId}
            approvals={pendingApprovals}
            onResolved={reload}
          />
        </div>
      ) : showInputBar ? (
        <div
          ref={dockRef}
          className={`${styles.bottomDock} ${standalone ? styles.bottomDockFixed : ''}`}
        >
          <FooterHint
            status={issue.status}
            assignedTo={issue.assigned_to}
            pendingCount={pendingQueue.length}
          />
          <ContinueInputBar
            issueId={issueId}
            continuedBy={issue.created_by}
            status={issue.status}
            assignedTo={issue.assigned_to}
            initialPrompt={issue.description || issue.title}
            onSubmitted={handleSubmitted}
            pendingQueue={pendingQueue}
            onPushPending={pushPending}
            onRemovePending={removePending}
          />
        </div>
      ) : null)}
    </div>
  )
}
