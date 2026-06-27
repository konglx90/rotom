import { useMemo } from 'react'
import type { Issue, TokenUsage } from '../../../api/types'
import { useIssueElapsed } from '../../../hooks/useIssueElapsed'
import { formatDurationCompact } from '../../../utils/formatDuration'
import styles from './IssueStatusBar.module.css'

// IssueStatusBar —— 输入框上方那一行,把「是不是还在跑」和 token 用量 / 耗时
// 集中到一处。原本这些信息散在 header(耗时 badge / usage badge),用户视线
// 在底部输入框,看不到 header 状态变化,所以挪到底部,且 in_progress 时左
// 侧状态点会呼吸 + 文案变成「执行中」,一眼能感知。
//
// 左:状态点 + 状态文案 + agent 名(已指派时)
// 右:model + ↑输入/↓输出 tokens + cost + ⏱耗时(in_progress 时每秒 tick)
interface IssueStatusBarProps {
  issue: Issue
  /** 执行过程中累积 token usage 的实时快照(WS issue_usage_progress)。
   *  命中当前 issueId 时优先于 issue.usage 显示,让 token 数字在 in_progress
   *  期间实时变化。undefined(IssuePanel 嵌入态 / 没订阅 / 不在 in_progress)
   *  时降级到 issue.usage(终态值)。 */
  liveUsage?: TokenUsage
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

export function IssueStatusBar({ issue, liveUsage }: IssueStatusBarProps) {
  const elapsedMs = useIssueElapsed(issue.started_at, issue.completed_at)
  const elapsedLabel = elapsedMs == null ? '—' : formatDurationCompact(elapsedMs)
  const visual = getStatusVisual(issue.status)

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
        <span className={styles.statusLabel}>{visual.label}</span>
        {issue.assigned_to && (
          <>
            <span className={styles.sep}>·</span>
            <code className={styles.agentName} title={`当前指派: ${issue.assigned_to}`}>
              {issue.assigned_to}
            </code>
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
                  {formatTokens(usage.inputTokens)}
                </span>
              )}
              {usage.outputTokens != null && (
                <span className={styles.tokenOut} title="输出 tokens">
                  <span className={styles.arrow}>↓</span>
                  {formatTokens(usage.outputTokens)}
                </span>
              )}
            </span>
            {usage.totalCostUsd != null && usage.totalCostUsd > 0 && (
              <span className={styles.cost} title="总成本 (USD)">
                ${formatCost(usage.totalCostUsd)}
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

// ↓↓↓ 从 UsageBadge 搬过来的格式化函数,保留同一套规则避免两处不一致。 ↓↓↓

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
