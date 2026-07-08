import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Agent, Issue, IssueEvent, TokenUsage } from '../../../api/types'
import { AsyncBoundary } from '../../../components/async/AsyncBoundary'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import { useSocket } from '../../../context/SocketContext'
import shared from './_shared.module.css'
import styles from './IssueDetail.module.css'
import { ContinueInputBar } from './ContinueInputBar'
import { IssueDetailHeader } from './IssueDetailHeader'
import { IssueEditForm } from './IssueEditForm'
import { IssueEventsTimeline } from './IssueEventsTimeline'
import { IssueStatusBar } from './IssueStatusBar'
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
  const { issue, events, loading, reload } = useIssueData(issueId, refreshSignal)
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
  // 订阅当前 issue 的实时 usage 推送(Master 只转发给订阅者,不广播)。
  // 订阅放在 IssueDetailBody 而非 IssueDetailPage,这样 standalone 路由和
  // IssuePanel 嵌入态(GroupChatView)都能拿到 liveUsage。wsStatus 依赖:
  // 重连后 SocketContext 会在 onopen 自动重发订阅,这里也补一次保险。
  // 访客模式 readOnly 不订阅(无权看 usage)。
  const { lastIssueUsageProgress, status: wsStatus, subscribeIssueDetail, unsubscribeIssueDetail } = useSocket()
  useEffect(() => {
    if (!issueId || readOnly) return
    if (wsStatus !== 'connected') return
    subscribeIssueDetail(issueId)
    return () => { unsubscribeIssueDetail(issueId) }
  }, [issueId, wsStatus, readOnly, subscribeIssueDetail, unsubscribeIssueDetail])
  const liveUsage: TokenUsage | undefined = lastIssueUsageProgress && lastIssueUsageProgress.issueId === issueId
    ? lastIssueUsageProgress.usage
    : undefined

  // 从 events 派生活动指示:最后一条 progress 事件的 created_at + 从 content
  // 提取的最后状态文案(Working/Running/Patching/...)。配合 IssueStatusBar 的
  // 本地 1s tick 显示「状态 · Xs/Xm Ys 前」,让用户一眼判断 CLI 是否还在动:
  //   - 思考中 · 3s 前       → 流式输出中,正常
  //   - 思考中 · 1m 30s 前   → 等流式请求,可能 API 慢
  //   - 执行命令 · 1m 0s 前  → 长命令跑着,没挂
  // events 通过 issue_changed reload 拿,CLI 持续输出时实时刷新;CLI 卡住时
  // events 不更新,但本地 tick 仍能算 elapsed 增长——这正是「疑似卡住」信号。
  const activity = useMemo(() => extractActivity(events), [events])

  // in_progress 期间用户已发送但 worker 还没消费的追加指令(chip 列表)。
  // 提升到 IssueDetail 层,让 ContinueInputBar(push)和 handleInterrupt
  // (中断时 flush + clear)都能访问。issue 翻终态时按下面 effect 处理。
  const [pendingQueue, setPendingQueue] = useState<string[]>([])
  const prevStatusRef = useRef<Issue['status'] | undefined>(undefined)
  // pendingQueue 的 ref 副本:status 变化 effect 只在 issue?.status 改变时跑,
  // 但 effect 里要读「用户最后一次加 chip 后」的最新队列。直接把 pendingQueue
  // 放 effect 依赖会让每次 push/remove 都重跑(还要先于本 effect 把 ref 置空,
  // 否则 reload 触发的二次渲染可能重入),所以走 ref 同步。
  const pendingQueueRef = useRef<string[]>([])
  pendingQueueRef.current = pendingQueue

  // 输入框当前草稿。也提升到这一层,让 ESC 中断时能把「还没按 Enter 入队的
  // textarea 文本」一并 flush 给 worker —— 对齐 ContinueInputBar placeholder
  // 承诺的「Esc 统一发送并中断当前步骤」。旧实现里 prompt 是 ContinueInputBar
  // 的内部 state,IssueDetailHeader 的 ESC 监听拿不到,只能 flush chip 队列;
  // 用户在 textarea 里写一半的指令会被「裸中断」丢进 paused 态,没有 resume。
  const [promptDraft, setPromptDraft] = useState('')
  const promptDraftRef = useRef('')
  promptDraftRef.current = promptDraft

  // 中断进行中标记。同样提升到这一层,IssueDetailHeader 的「■ 中断」按钮和
  // 全局 ESC 监听都用同一个状态去重,避免按钮和快捷键各自维护闭包。
  const [interrupting, setInterrupting] = useState(false)
  const interruptingRef = useRef(false)

  // 「已提交状态翻转动作,正在等 worker 接单」标记。提交 /append(start /
  // paused)或 /continue(completed/failed)HTTP 返回 200 后,worker 实际
  // 还要做 git fetch + spawn CLI,要 30-90s 才把 issue.status 真正翻到
  // in_progress。这期间前端按返回看不到任何变化,用户会以为没点上、重复点。
  // 挂上 pendingStart 后:ContinueInputBar 按钮显「启动中…」+ 禁用,
  // IssueStatusBar 状态点转起来 + 文案显「启动中」,撑到 reload 看到 status
  // 真翻转再清。chip 入队(in_progress Enter)不走这里:它本就是即时的。
  const [pendingStart, setPendingStart] = useState(false)

  // 中断当前步骤(对齐 codex CLI 的 ESC + flush steers)。把 pendingQueue
  // 里的草稿逐条 flush 给 worker,再 POST /interrupt → worker abort 当前
  // CLI → runIssueExecution finally 块消费 pendingAppends 用 --resume 续跑。
  // 关键修复:textarea 里还没入队的草稿也一起 flush,避免「裸中断」把用户
  // 正在编辑的指令丢进 paused 态而没有 resume。
  const handleInterrupt = useCallback(async () => {
    if (interruptingRef.current) return
    interruptingRef.current = true
    setInterrupting(true)
    try {
      const queued = pendingQueueRef.current
      const draft = promptDraftRef.current.trim()
      // 顺序:先 chip 队列(用户已 Enter 入队的),最后是当前 textarea 草稿。
      // 时间线上的「追加指令」气泡顺序与用户输入一致。
      const allTexts = draft ? [...queued, draft] : queued
      for (const text of allTexts) {
        await issuesApi.append(issue.id, text, issue.created_by)
      }
      await issuesApi.interrupt(issue.id, issue.created_by)
      // 先把本地 chip + 草稿清掉,避免 reload 期间旧内容闪一帧。
      if (queued.length > 0) {
        setPendingQueue([])
        pendingQueueRef.current = []
      }
      if (draft) {
        setPromptDraft('')
        promptDraftRef.current = ''
      }
      await reload()
    } catch (err) {
      console.error('Failed to interrupt issue:', err)
    } finally {
      interruptingRef.current = false
      setInterrupting(false)
    }
  }, [issue.id, issue.created_by, reload])

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

  // 记录用户是否停留在底部附近。点击 apply patch / 批准 / 拒绝等操作会触发
  // reload → events 重渲染 → content 高度变化 → RO 触发。此时若用户已经向上
  // 滚动阅读历史,强制 scrollToBottom 会打断阅读;只有「贴底」时才跟随新内容
  // 滚动,显式的 scrollToBottom(handleSubmitted 等)不受此约束。
  const isNearBottomRef = useRef(true)
  const NEAR_BOTTOM_THRESHOLD = 80

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

  // 监听用户手动滚动:更新 isNearBottomRef。RO 触发时据此决定是否跟随。
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const onScroll = () => {
      const distance = body.scrollHeight - body.scrollTop - body.clientHeight
      isNearBottomRef.current = distance <= NEAR_BOTTOM_THRESHOLD
    }
    body.addEventListener('scroll', onScroll, { passive: true })
    return () => body.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => {
      // 用户主动向上阅读时,新内容到达不强制跳底,保持当前视线位置。
      if (isNearBottomRef.current) scrollToBottom()
    })
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

  const handleSubmitted = useCallback(async (action: 'start' | 'chip' | 'append' | 'continue') => {
    // 状态翻转动作(start / append / continue)挂 pendingStart:HTTP 已 200,
    // 但 worker 还没把 issue.status 真正挑到 in_progress,这期间要给用户
    // loading 视觉。chip 是 in_progress 下 Enter 入队,本就是即时的,不挂。
    if (action !== 'chip') setPendingStart(true)
    await reload()
    scrollToBottom()
  }, [reload, scrollToBottom])

  // pendingStart 清除时机:
  //   1. issue.status 翻进 in_progress(正常路径:worker 把任务挑起来了)或
  //      任一终态(completed/failed/cancelled —— 异常路径:worker 拒单 / 用户
  //      在别处取消)。open/paused 不清,因为那正是 worker 还没接单的状态。
  //   2. 60s 兜底:网络挂了 / worker 卡死 / git fetch 超时,status 一直不
  //      变,不能让用户永远看着「启动中…」。日志里见过 git fetch 超时
  //      卡 75s,所以兜底放到 60s 之后。
  // 两条路都走 setPendingStart(false),幂等。
  useEffect(() => {
    if (!pendingStart) return
    if (issue?.status === 'in_progress' || issue?.status === 'completed' || issue?.status === 'failed' || issue?.status === 'cancelled') {
      setPendingStart(false)
    }
  }, [issue?.status, pendingStart])

  useEffect(() => {
    if (!pendingStart) return
    const id = setTimeout(() => setPendingStart(false), 60_000)
    return () => clearTimeout(id)
  }, [pendingStart])

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
        onInterrupt={handleInterrupt}
        interrupting={interrupting}
        readOnly={readOnly}
      />

      {issue.latest_todos && issue.latest_todos.length > 0 && (
        <div className={styles.todosSticky}>
          <WorkerTodosPanel
            todos={issue.latest_todos}
            agentName={issue.assigned_to || ''}
            active={issue.status === 'in_progress' || issue.status === 'paused'}
          />
        </div>
      )}

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


          <IssueEventsTimeline
            events={events}
            issueId={issueId}
            inProgress={issue.status === 'in_progress'}
            onApprovalResolved={reload}
          />

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
              <div className={shared.artifactsTitle}>执行结果</div>
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
          <IssueStatusBar issue={issue} liveUsage={liveUsage} activity={activity} pendingStart={pendingStart} />
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
            prompt={promptDraft}
            onPromptChange={setPromptDraft}
            pendingStart={pendingStart}
          />
        </div>
      ) : null)}
    </div>
  )
}

// 从 events 派生活动指示:最后一条 progress 事件的时间戳 + 状态文案。
// 状态文案从 `[status:thinking]X[/status:thinking]` 标签提取(emitStatus 注入)。
// 找不到 status 标签时降级到 event_type 本身(approval_request / todos 等)。
// 返回 null 表示该 issue 没有任何 progress 事件(刚创建未开始)。
export interface IssueActivity {
  /** 最后一条 progress 事件的 created_at(ISO)。前端 tick 算「Xs 前」。 */
  lastAt: string
  /** 提取的状态文案,如「思考中」「执行命令」「编辑文件」。null = 没状态标签。 */
  statusLabel: string | null
}

function extractActivity(events: IssueEvent[]): IssueActivity | null {
  // 倒序找最后一条 progress 事件(跳过 approval_request / todos / created 等
  // 非输出流事件——这些不反映 CLI 当前在干嘛)。
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.event_type !== 'progress') continue
    const statusLabel = extractStatusFromContent(ev.content)
    return { lastAt: ev.created_at, statusLabel }
  }
  return null
}

// 从 progress 事件 content 提取状态文案。content 形如:
//   [status:thinking]Working[/status:thinking]
//   [tool:exec]ls -la[/tool:exec]
//   [tool-result:exec]...[/tool-result:exec]
// 只有 [status:thinking]X[/status:thinking] 能提取出状态文案;tool 类返回 null
// (调用方会继续往前找,直到找到 status 事件或耗尽)。
// 但实际上 extractActivity 只看最后一条 progress,如果是 tool:exec 就返回 null
// statusLabel —— 这种情况前端会降级到 issue.status 的默认文案(执行中)。
// 更精细的做法:继续往前找 status 事件。但 tool:exec 后通常紧跟 status:Running,
// 所以最后一条往往就是 status 事件,够用。
function extractStatusFromContent(content: string): string | null {
  const m = content.match(/\[status:thinking\]([^\]]+)\[\/status:thinking\]/)
  if (!m) return null
  return mapStatusToLabel(m[1])
}

// emitStatus 用的英文 key 映射到中文文案。未匹配的回退到原文。
function mapStatusToLabel(s: string): string {
  const map: Record<string, string> = {
    Working: '思考中',
    Running: '执行命令',
    Patching: '编辑文件',
    Asking: '询问中',
    Answered: '已回答',
    Done: '完成',
    Failed: '失败',
  }
  return map[s] ?? s
}
