import { useMemo } from 'react'
import type { Issue, TokenUsage } from '../../../api/types'
import styles from './UsageBadge.module.css'

interface UsageBadgeProps {
  issue: Issue
}

/** Issue 详情头部小徽章：展示该 issue 最近一次执行的模型 + token 用量 + 成本。
 *  数据来源是 issue.usage（TokenUsage JSON 字符串）和 issue.model。
 *  两者都没有时返回 null,徽章不渲染。 */
export function UsageBadge({ issue }: UsageBadgeProps) {
  const usage = useMemo<TokenUsage | null>(() => {
    if (!issue.usage) return null
    try {
      const parsed = JSON.parse(issue.usage) as TokenUsage
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }, [issue.usage])

  const model = issue.model ?? null
  // usage 各字段都缺时,只剩 model 也算有用 —— 展示模型名。两者都缺才隐藏。
  const hasUsage = !!usage && (
    usage.inputTokens != null
    || usage.outputTokens != null
    || usage.cacheReadTokens != null
    || usage.cacheCreationTokens != null
    || usage.totalCostUsd != null
  )
  if (!hasUsage && !model) return null

  return (
    <span className={styles.usageBadge} title={buildTooltip(usage, model)}>
      {model && <span className={styles.model}>{shortModel(model)}</span>}
      {hasUsage && (
        <>
          {model && <span className={styles.sep}>·</span>}
          <span className={styles.tokens}>
            {usage?.inputTokens != null && (
              <span className={styles.tokenIn} title="输入 tokens">
                <span className={styles.arrow}>↑</span>
                {formatTokens(usage.inputTokens)}
              </span>
            )}
            {usage?.outputTokens != null && (
              <span className={styles.tokenOut} title="输出 tokens">
                <span className={styles.arrow}>↓</span>
                {formatTokens(usage.outputTokens)}
              </span>
            )}
          </span>
          {usage?.totalCostUsd != null && usage.totalCostUsd > 0 && (
            <>
              <span className={styles.sep}>·</span>
              <span className={styles.cost} title="总成本 (USD)">${formatCost(usage.totalCostUsd)}</span>
            </>
          )}
        </>
      )}
    </span>
  )
}

function buildTooltip(usage: TokenUsage | null, model: string | null): string {
  const parts: string[] = []
  if (model) parts.push(`模型: ${model}`)
  if (usage) {
    if (usage.inputTokens != null) parts.push(`输入: ${usage.inputTokens.toLocaleString()}`)
    if (usage.outputTokens != null) parts.push(`输出: ${usage.outputTokens.toLocaleString()}`)
    if (usage.cacheReadTokens != null) parts.push(`缓存读: ${usage.cacheReadTokens.toLocaleString()}`)
    if (usage.cacheCreationTokens != null) parts.push(`缓存写: ${usage.cacheCreationTokens.toLocaleString()}`)
    if (usage.totalCostUsd != null) parts.push(`成本: $${usage.totalCostUsd.toFixed(6)}`)
  }
  return parts.join(' · ') || '无 usage 数据'
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
  // claude-sonnet-4-6 → sonnet-4-6
  const stripped = model.replace(/^(claude|anthropic|openai|gpt|gemini)-/i, '')
  if (stripped.length <= 22) return stripped
  return stripped.slice(0, 21) + '…'
}
