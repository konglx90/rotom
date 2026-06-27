import { useEffect, useMemo, useState } from 'react'
import type { Issue, TokenUsage } from '../../../api/types'
import { useIssueElapsed } from '../../../hooks/useIssueElapsed'
import { formatDurationCompact } from '../../../utils/formatDuration'
import type { IssueActivity } from './IssueDetail'
import styles from './IssueStatusBar.module.css'

// IssueStatusBar —— 输入框上方那一行,把「是不是还在跑」和 token 用量 / 耗时
// 集中到一处。原本这些信息散在 header(耗时 badge / usage badge),用户视线
// 在底部输入框,看不到 header 状态变化,所以挪到底部,且 in_progress 时左
// 侧状态点会呼吸 + 文案变成「执行中」,一眼能感知。
//
// 左:状态点 + 状态文案(优先用 activity.statusLabel,降级到 issue.status 默认) +
//      agent 名 + 「Xs 前」活动指示(in_progress 时)
// 右:model + ↑输入/↓输出 tokens + cost + ⏱耗时(in_progress 时每秒 tick)
interface IssueStatusBarProps {
  issue: Issue
  /** 执行过程中累积 token usage 的实时快照(WS issue_usage_progress)。 */
  liveUsage?: TokenUsage
  /** 从 events 派生的活动指示:最后一条 progress 事件的时间戳 + 状态文案。
   *  用来显示「思考中 · 3s 前」这种实时活动信号,让用户判断 CLI 是否卡住。 */
  activity?: IssueActivity | null
}

interface StatusVisual {
  label: string
  dotClass: string
  spin: boolean
}

function getStatusVisual(status: Issue['status']): StatusVisual {
  switch (status) {
    case 'open':        return { label: '待处理', dotClass: 'idle',    spin: false }
    case 'in_progress': return { label: '执行中', dotClass: 'running', spin: true  }
    case 'paused':      return { label: '待继续', dotClass: 'paused',  spin: false }
    case 'completed':   return { label: '已完成', dotClass: 'done',    spin: false }
    case 'failed':      return { label: '失败',   dotClass: 'failed',  spin: false }
    case 'cancelled':   return { label: '已取消', dotClass: 'idle',    spin: false }
  }
}

export function IssueStatusBar({ issue, liveUsage, activity }: IssueStatusBarProps) {
  const elapsedMs = useIssueElapsed(issue.started_at, issue.completed_at)
  const elapsedLabel = elapsedMs == null ? '—' : formatDurationCompact(elapsedMs)
  const visual = getStatusVisual(issue.status)

  // 活动指示:in_progress / paused 时每秒本地 tick,算「距上次活动 Xs」。
  // events 通过 issue_changed reload 拿,CLI 持续输出时 activity.lastAt 实时
  // 刷新;CLI 卡住时 lastAt 不变,但本地 tick 让 elapsed 持续增长——这正是
  // 「疑似卡住」的信号。终态(completed/failed/cancelled)不显示活动指示,
  // 因为已经不跑了。
  const isActive = issue.status === 'in_progress' || issue.status === 'paused'
  const activityElapsedMs = useActivityElapsed(isActive ? activity?.lastAt : null)
  const activityLabel = activityElapsedMs == null ? null : formatActivityAgo(activityElapsedMs)
  // 阈值变色:>30s 警告(黄),>60s 危险(红)。配合 spinner 呼吸,用户一眼能看出
  // 「还在动」vs「疑似卡了」。
  const activityClass = activityElapsedMs == null
    ? ''
    : activityElapsedMs >= 60_000
      ? styles.activityDanger
      : activityElapsedMs >= 30_000
        ? styles.activityWarn
        : styles.activityFresh

  // 状态文案:优先用 activity.statusLabel(从 events 提取的具体状态,如「思考中」
  // 「执行命令」),降级到 issue.status 的默认文案(「执行中」「待继续」)。
  const statusLabel = isActive && activity?.statusLabel ? activity.statusLabel : visual.label

  const persistedUsage = useMemo<TokenUsage | null>(() => {
    if (!issue.usage) return null
    try {
      const parsed = JSON.parse(issue.usage) as TokenUsage
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }, [issue.usage])

  // 实时累积值(liveUsage)优先;没有时降级到 DB 终态值(persistedUsage)。
  // in_progress 时 liveUsage 持续刷新,token 数字随之变化;翻终态后 worker
  // flush 用 result.usage 覆盖,DB 终态值与最后一次 live 推送口径一致。
  const usage: TokenUsage | null = liveUsage ?? persistedUsage

  const model = issue.model ?? null
  const hasTokens = !!usage && (
    usage.inputTokens != null
    || usage.outputTokens != null
    || usage.cacheReadTokens != null
    || usage.cacheCreationTokens != null
    || usage.totalCostUsd != null
  )

  const elapsedTitle = elapsedMs == null
    ? '尚未开始(等待 worker 认领)'
    : issue.status === 'completed' || issue.status === 'failed' || issue.status === 'cancelled'
      ? '总耗时'
      : '当前区间耗时(实时刷新)'

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        <span
          className={`${styles.statusDot} ${styles[`dot_${visual.dotClass}`]}`}
          data-spin={visual.spin}
        />
        <span className={styles.statusLabel}>{statusLabel}</span>
        {issue.assigned_to && (
          <>
            <span className={styles.sep}>·</span>
            <code className={styles.agentName} title={`当前指派: ${issue.assigned_to}`}>
              {issue.assigned_to}
            </code>
          </>
        )}
        {activityLabel && (
          <>
            <span className={styles.sep}>·</span>
            <span className={`${styles.activity} ${activityClass}`} title={`距上次 CLI 输出: ${activityLabel}\n> 30s 疑似卡住,> 60s 建议中断检查`}>
              {activityLabel}
            </span>
          </>
        )}
      </div>

      <div className={styles.right}>
        {model && <span className={styles.model}>{shortModel(model)}</span>}
        {hasTokens && usage && (
          <>
            {model && <span className={styles.sep}>·</span>}
            <span className={styles.tokens}>
              {usage.inputTokens != null && (
                <span className={styles.tokenIn} title="输入 tokens">
                  <span className={styles.arrow}>↑</span>
                  <span key={usage.inputTokens} className={styles.tokenValue}>
                    {formatTokens(usage.inputTokens)}
                  </span>
                </span>
              )}
              {usage.outputTokens != null && (
                <span className={styles.tokenOut} title="输出 tokens">
                  <span className={styles.arrow}>↓</span>
                  <span key={usage.outputTokens} className={styles.tokenValue}>
                    {formatTokens(usage.outputTokens)}
                  </span>
                </span>
              )}
            </span>
            {usage.totalCostUsd != null && usage.totalCostUsd > 0 && (
              <span className={styles.cost} title="总成本 (USD)">
                $<span key={usage.totalCostUsd} className={styles.tokenValue}>
                  {formatCost(usage.totalCostUsd)}
                </span>
              </span>
            )}
          </>
        )}
        <span className={styles.sep}>·</span>
        <span className={styles.elapsed} title={elapsedTitle}>
          <span className={styles.elapsedIcon}>⏱</span>
          <code className={styles.elapsedValue}>{elapsedLabel}</code>
        </span>
      </div>
    </div>
  )
}

// 每秒 tick 算 now - lastAt 的毫秒数。lastAt 为 null 时返回 null(不显示)。
// 跟 useIssueElapsed 同样的模式,但不区分 completed(活动指示只关心「距上次
// 输出多久」,不关心总耗时)。组件卸载自动 clearInterval。
function useActivityElapsed(lastAt: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!lastAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [lastAt])
  if (!lastAt) return null
  return Math.max(0, now - new Date(lastAt).getTime())
}

/** 1247 -> "1.2k", 1254000 -> "1.3M" */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(usd: number): string {
  if (usd >= 0.01) return usd.toFixed(2)
  if (usd >= 0.0001) return usd.toFixed(4)
  return usd.toFixed(6)
}

/** 把过长的模型名截短,但保留版本号关键信息。 */
function shortModel(model: string): string {
  const stripped = model.replace(/^(claude|anthropic|openai|gpt|gemini)-/i, '')
  if (stripped.length <= 22) return stripped
  return stripped.slice(0, 21) + '…'
}

// 每秒 tick 算 now - lastAt 的毫秒数。lastAt 为 null 时返回 null(不显示)。
// 跟 useIssueElapsed 同样的模式,但不区分 completed(活动指示只关心「距上次
// 输出多久」,不关心总耗时)。组件卸载自动 clearInterval。
// (重复定义已清理,实际函数在上方)
function formatActivityAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  const h = Math.floor(m / 60)
  return `${h}h 前`
}
