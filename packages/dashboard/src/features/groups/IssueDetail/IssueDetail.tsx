import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Agent } from '../../../api/types'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import shared from './_shared.module.css'
import styles from './IssueDetail.module.css'
import { CollaborationMessages } from './CollaborationMessages'
import { ContinueInputBar } from './ContinueInputBar'
import { IssueDetailHeader } from './IssueDetailHeader'
import { IssueEditForm } from './IssueEditForm'
import { IssueEventsTimeline } from './IssueEventsTimeline'
import { PendingApprovalsBar } from './PendingApprovalsBar'
import { useIssueData } from './useIssueData'
import { useIssueEdit } from './useIssueEdit'

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
}

export function IssueDetail({ issueId, refreshSignal, agents, groupMembers, onBack, standalone = false }: IssueDetailProps) {
  const { issue, events, messages, loading, reload } = useIssueData(issueId, refreshSignal)
  const edit = useIssueEdit(issue, reload)

  // 把所有 status='pending' 的 approval_request 提取出来,渲染成悬浮在底部
  // 按钮上方的快捷确认条。信息流里的 ApprovalCard 同步保留,既能看到上下文
  // 也能用其两阶段 deny 输入完整 feedback。
  //
  // 必须放在 early return 之前,否则首次 loading=true 返回时这个 hook 不会注册,
  // 等数据到达再次渲染时 hooks 数量会对不上(React 报 "Rendered more hooks than
  // during the previous render")。
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

  if (loading) return <div className={styles.issueEmpty}>加载中...</div>
  if (!issue) return <div className={styles.issueEmpty}>Issue 未找到</div>

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
                <MarkdownContent content={issue.description} />
              </div>
            )
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
                <div key={i} className={styles.artifactItem}>{a}</div>
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
          的「正常输入 → 选项确认 → 回到输入」交互)。cancelled 终态下两者都不渲染。 */}
      {pendingApprovals.length > 0 ? (
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
          <ContinueInputBar
            issueId={issueId}
            continuedBy={issue.created_by}
            status={issue.status}
            assignedTo={issue.assigned_to}
            initialPrompt={issue.description || issue.title}
            onSubmitted={handleSubmitted}
          />
        </div>
      ) : null}
    </div>
  )
}
