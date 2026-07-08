import { useEffect, useRef, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Issue } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { Textarea } from '../../../components/ui/Textarea'
import { useIsPad } from '../../../hooks/useIsPad'
import styles from './ContinueInputBar.module.css'
import { PendingQueuePreview } from './PendingQueuePreview'

// ContinueInputBar — 常驻在 IssueDetail 底部的输入栏。根据 issue.status +
// assigned_to 切换提交通道与文案:
//   - open  + 未指派 → disabled,提示先指派 Agent
//   - open  + 已指派 → 预填 description 供编辑,按钮「开始任务」,提交走 /append
//   - in_progress    → 追加指令,按钮「加入队列」。**只入本地草稿队列(chip),
//                       不立即调 /append** —— 对齐 codex CLI 的 Enter 入队 / Esc
//                       flush 交互。用户按 ESC 时 IssueDetailBody.handleInterrupt
//                       会把草稿(含 textarea 当前文本)逐条 flush 给 worker,
//                       然后 worker abort + finally 块(worker-issue.ts:217-256)
//                       用 --resume 续跑。上方展示 PendingQueuePreview chip 列表
//                       (对齐 codex PendingInputPreview)。
//   - paused         → 中断后待继续,按钮「继续执行」,提交走 /append(worker
//                       走 idle 分支用 --resume 续跑)。无队列预览。
//   - completed/failed → 续聊,按钮「继续执行」,提交走 /continue
//   - cancelled      → 父组件不渲染本组件
//
// prompt 是受控 prop(由 IssueDetailBody 持有),这样 ESC 中断时父组件的
// handleInterrupt 能同步读到 textarea 当前文本,一并 flush 给 worker。
//
// pendingStart:提交完「会触发 status 翻进 in_progress」的动作(开始任务 /
// paused 续跑 / completed/failed 续聊)后,父组件挂这个标记,等 reload 看到
// issue.status 真的变成 in_progress 时清掉。这期间 worker 在拉仓库 / spawn
// CLI,前端按 HTTP 返回看不到任何变化 —— 输入栏必须自己撑住 loading 视觉,
// 否则用户以为点了没反应、重复点。chip 入队(in_progress 下 Enter)不挂这个
// 标记:它本就是即时的。

/** 提交动作分类。IssueDetailBody 用它判断要不要挂 pendingStart。 */
export type SubmitAction = 'start' | 'chip' | 'append' | 'continue'

interface ContinueInputBarProps {
  issueId: string
  /** 用作 continuedBy / appendedBy 字段。 */
  continuedBy: string
  status: Issue['status']
  assignedTo?: string | null
  /** open + 已指派且输入框为空时,预填此文本(通常是 issue.description)。 */
  initialPrompt?: string
  /** 提交成功后回调。action 告诉父组件发生了什么(start / append / continue
   *  会翻转 status 到 in_progress;chip 只是入队,不翻转)。 */
  onSubmitted: (action: SubmitAction) => Promise<void> | void
  /** in_progress 期间已发送但 worker 还没消费的追加指令(chip 列表)。
   *  由 IssueDetail 持有,中断 / 翻终态时清空。 */
  pendingQueue?: string[]
  onPushPending?: (text: string) => void
  onRemovePending?: (idx: number) => void
  /** 当前 textarea 文本(受控)。父组件持有是为了 ESC 中断时能同步 flush。 */
  prompt: string
  onPromptChange: (next: string) => void
  /** 已提交状态翻转动作,正在等 worker 把 issue 挑到 in_progress。
   *  期间输入栏整体禁用 + 按钮显示「启动中…」,避免用户重复点。 */
  pendingStart?: boolean
}

export function ContinueInputBar({
  issueId, continuedBy, status, assignedTo, initialPrompt, onSubmitted,
  pendingQueue, onPushPending, onRemovePending,
  prompt, onPromptChange, pendingStart = false,
}: ContinueInputBarProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pad/触屏设备没有物理 ESC 键,placeholder/hint 里不能依赖 ESC 文案,
  // 否则用户找不到入口会困惑(对齐 issue #f291053d 的 Pad 适配)。
  const isPad = useIsPad()

  const isOpen = status === 'open'
  const isInProgress = status === 'in_progress'
  const isPaused = status === 'paused'
  const hasAssignee = !!assignedTo
  const disabled = isOpen && !hasAssignee
  // open + 已指派 = 等待用户「开始任务」(worker 因 assigned_to 非空被 auto-claim
  // 阻断,只能由用户主动触发)。in_progress = 真正执行中,append 走队列。
  const isStartMode = isOpen && hasAssignee

  // 进入 "open + 已指派" 时把 initialPrompt 预填一次,让用户能确认/编辑后开始任务。
  // 用 ref 锁住 issueId,切换到别的 issue / 状态翻走再回来时不重复覆盖用户输入。
  const prefilledForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isStartMode) {
      prefilledForRef.current = null
      return
    }
    const key = `${issueId}:${assignedTo}`
    if (prefilledForRef.current === key) return
    prefilledForRef.current = key
    if (!prompt && initialPrompt) onPromptChange(initialPrompt)
  }, [isStartMode, issueId, assignedTo, initialPrompt, prompt, onPromptChange])

  const submit = async () => {
    const trimmed = prompt.trim()
    // pendingStart 期间禁止再次提交:上一条还在等 worker 接单,重复点只会
    // 把同一 prompt 排两次(worker 收到 issue_append 时 activeTasks 没这条,
    // 会立即起新一轮,跟已经在路上的那条抢 CLI slot)。
    if (!trimmed || submitting || disabled || pendingStart) return
    setSubmitting(true)
    setError(null)
    let action: SubmitAction | null = null
    try {
      if (status === 'open' || status === 'paused') {
        // open / paused 都是「立即执行」分支:worker 收到 issue_append 时
        // activeTasks 没这条,走 else 直接起新一轮(worker.ts:738-751),
        // 所以不需要本地草稿 chip。
        await issuesApi.append(issueId, trimmed, continuedBy)
        action = status === 'open' ? 'start' : 'append'
      } else if (isInProgress) {
        // in_progress:对齐 codex CLI 的 Enter 入队 / Esc flush。只入本地
        // 草稿队列(chip),不立即调 /append。两条 flush 路径都会把草稿真正
        // 发给 worker 触发 --resume 续跑:
        //   - 用户按 ESC → IssueDetailBody.handleInterrupt 逐条 /append +
        //     /interrupt,worker abort + finally 块(worker-issue.ts:217-256)
        //     消费队列(包括 textarea 当前草稿)。
        //   - 用户不按 ESC、worker 自然跑完 → IssueDetail 的 status 监听自动
        //     /continue(completed/failed)或 /append(paused),worker 用 session_id
        //     起新轮。对齐 codex "steers persist across rounds"。
        onPushPending?.(trimmed)
        action = 'chip'
      } else if (status === 'completed' || status === 'failed') {
        await issuesApi.continue(issueId, trimmed, continuedBy)
        action = 'continue'
      } else {
        return
      }
      onPromptChange('')
      await onSubmitted(action)
    } catch (err) {
      setError((err as Error).message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  // 快捷键提示:对齐 codex CLI footer.rs 的状态机,放在按钮同一行左侧。
  //   open + 已指派        → Enter 开始任务
  //   in_progress(空闲)   → Esc 中断 · Enter 加入队列
  //   in_progress + 有队列 → Esc 立即处理队列 · N 条待处理
  //   paused              → Enter 用上一轮 session 续跑
  //   completed/failed     → Enter 继续执行
  //   cancelled / open 未指派 → 不显示
  // pad 模式:Pad 没物理 ESC,改用「■ 中断」按钮作为中断入口(IssueDetailHeader
  // 的 headerPrimaryMeta 常驻显示),文案上明确指过去,避免用户找 ESC。
  const hint = (() => {
    if (isOpen && hasAssignee) return 'Enter 开始任务 · Shift+Enter 换行'
    if (isInProgress) {
      const queueLen = pendingQueue?.length ?? 0
      if (isPad) {
        return queueLen > 0
          ? `点上方「■ 中断」立即处理队列 · ${queueLen} 条待处理 · Enter 加入队列`
          : '点上方「■ 中断」中断当前步骤 · Enter 加入队列 · 换行 Shift+Enter'
      }
      return queueLen > 0
        ? `Esc 立即处理队列 · ${queueLen} 条待处理 · Enter 加入队列`
        : 'Esc 中断当前步骤 · Enter 加入队列 · Shift+Enter 换行'
    }
    if (isPaused) return '中断后待继续 · Enter 用上一轮 session 续跑 · Shift+Enter 换行'
    if (status === 'completed' || status === 'failed') return 'Enter 继续执行(基于上次 session) · Shift+Enter 换行'
    return null
  })()

  const placeholder = (() => {
    if (disabled) return '请先在上方指派 Agent，再发送指令'
    if (isStartMode) return `确认或编辑给 ${assignedTo} 的 prompt，点下方「开始任务」`
    if (isInProgress) {
      // pad 上不能依赖 ESC,改文案指「■ 中断」按钮(对齐上方 hint)。
      return isPad
        ? '输入追加指令(Enter 入草稿队列,点上方「■ 中断」统一发送并中断当前步骤)…'
        : '输入追加指令(Enter 入草稿队列,Esc 统一发送并中断当前步骤)…'
    }
    if (isPaused) return '中断后待继续。输入指令后 worker 会用上一轮 session 续跑…'
    if (status === 'completed') return '执行完成。补充新指令继续对话(基于上次 session)…'
    if (status === 'failed') return '上次执行失败。在这里告诉 Agent 怎么修后继续…'
    return ''
  })()

  const submitLabel = (() => {
    // pendingStart 期间按钮文案统一变「启动中…」:无论 start / append /
    // continue,这一刻用户的预期都是「我让它跑了,在等它起来」,而不是
    // 回到「开始任务」让人以为没点上。submitting(HTTP 在飞)优先级更高,
    // 但通常只持续几十毫秒,视觉上几乎看不到。
    if (submitting) return '提交中…'
    if (pendingStart) return '启动中…'
    if (isStartMode) return '开始任务'
    if (isInProgress) return '加入队列'
    if (isPaused) return '继续执行'
    return '继续执行'
  })()

  return (
    <div className={styles.continueInputBar}>
      {isInProgress && pendingQueue && pendingQueue.length > 0 && (
        <PendingQueuePreview items={pendingQueue} onRemove={idx => onRemovePending?.(idx)} />
      )}
      <Textarea
        className={styles.continueInputTextarea}
        value={prompt}
        onChange={e => onPromptChange(e.target.value)}
        onKeyDown={e => {
          // Enter 提交,Shift+Enter 换行(聊天式交互,对齐 codex/ChatGPT)。
          // 输入法组合中(keyCode 229)不拦截,避免打断中文输入。
          if (e.key === 'Enter' && !e.shiftKey && e.keyCode !== 229) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder={placeholder}
        disabled={submitting || disabled || pendingStart}
        rows={isStartMode ? 4 : 2}
      />
      <div className={styles.continueInputActions}>
        {hint && <span className={styles.continueInputHint}>{hint}</span>}
        {error && <span className={styles.continueInputError}>{error}</span>}
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={submitting || disabled || pendingStart || !prompt.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
