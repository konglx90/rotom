import { useEffect, useRef, useState, useCallback } from 'react'
import { sessionsApi, type SessionEntry, type SessionUsage } from '../../api/sessions'
import type { TokenUsage } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import styles from './GroupChatView.module.css'

interface SessionPanelProps {
  groupId: string
  /** Notified with the latest session count whenever the list changes.
   *  Parent (e.g. collapsed Debug header) uses this to render a count badge
   *  without re-fetching. `null` means the count is not currently known.
   *  Must be stable (wrap in useCallback) — the panel reads it via a ref so
   *  a fresh function on every render will not refetch. */
  onChange?: (count: number | null) => void
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; sessions: SessionEntry[] }
  | { kind: 'error'; message: string }

/**
 * Per-group session list. For each backend (claude/codex/hermes) that
 * has an active SessionStore entry for this group, surface its sessionId and
 * give the user two affordances:
 *   - 查看: opens a modal with the tail of the session transcript
 *   - 删除: drops the entry from the executor's SessionStore, so the next
 *           chat / issue run starts fresh instead of --resume'ing this one.
 */
export function SessionPanel({ groupId, onChange }: SessionPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [viewing, setViewing] = useState<SessionEntry | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  // Read onChange via a ref so a fresh function on every render does not
  // re-trigger reload().
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const reload = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const { sessions } = await sessionsApi.list(groupId)
      setState({ kind: 'ready', sessions })
      onChangeRef.current?.(sessions.length)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({ kind: 'error', message: msg })
      onChangeRef.current?.(null)
    }
  }, [groupId])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleDelete = useCallback(
    async (entry: SessionEntry) => {
      const who = entry.agentName ?? entry.cliTool
      const ok = window.confirm(
        `确定删除 ${who} 在该群的 session?\n${entry.cliTool} · ${entry.sessionId}\n\n下次对话将重新开始。`,
      )
      if (!ok) return
      setDeleting(`${entry.cliTool}:${entry.sessionId}`)
      try {
        await sessionsApi.delete(entry.cliTool, entry.groupId, entry.sessionId)
        await reload()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        window.alert(`删除失败：${msg}`)
      } finally {
        setDeleting(null)
      }
    },
    [reload],
  )

  if (state.kind === 'loading') {
    return <div className={styles.hint}>加载中…</div>
  }

  if (state.kind === 'error') {
    return (
      <div className={styles.hint}>
        加载失败：{state.message}
        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" size="sm" onClick={reload}>
            重试
          </Button>
        </div>
      </div>
    )
  }

  if (state.sessions.length === 0) {
    return (
      <div className={styles.hint}>
        暂无 session
        <div className={styles.hintSub}>
          触发一次对话后,各后端(claude / codex / hermes)会自动登记 sessionId。
        </div>
      </div>
    )
  }

  return (
    <div className={styles.sessionPanel}>
      {state.sessions.map((entry) => {
        const key = `${entry.cliTool}:${entry.sessionId}`
        const isDeleting = deleting === key
        const invalidated = !!entry.invalidatedAt
        return (
          <div key={key} className={`${styles.sessionRow} ${invalidated ? styles.sessionRowInvalidated : ''}`}>
            <div
              className={styles.sessionCliTag}
              title={entry.agentName ? `${entry.agentName} · ${entry.cliTool}` : entry.cliTool}
            >
              {entry.agentName ?? entry.cliTool}
            </div>
            {entry.agentName && (
              <div className={styles.sessionCliSubTag} title={entry.cliTool}>
                {entry.cliTool}
              </div>
            )}
            <span
              className={`${styles.sessionOnlineDot} ${entry.online ? styles.sessionOnlineDotOn : styles.sessionOnlineDotOff}`}
              title={entry.online ? 'worker 在线' : 'worker 离线'}
            />
            <div className={styles.sessionId} title={entry.sessionId}>
              {entry.sessionId.length > 14
                ? `${entry.sessionId.slice(0, 6)}…${entry.sessionId.slice(-4)}`
                : entry.sessionId}
            </div>
            <SessionUsageLine entry={entry} />
            {invalidated && (
              <span className={styles.sessionInvalidatedTag} title={`失效于 ${entry.invalidatedAt}`}>
                已失效
              </span>
            )}
            <div className={styles.sessionActions}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewing(entry)}
                disabled={isDeleting}
              >
                查看
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(entry)}
                disabled={isDeleting}
              >
                {isDeleting ? '删除中…' : '删除'}
              </Button>
            </div>
          </div>
        )
      })}
      <SessionViewModal
        entry={viewing}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}

/** 每个 session 行尾的 usage 小药丸。
 *  列表渲染后异步并发拉取,不阻塞首屏。
 *
 *  数据源是 worker 在每次 chat turn 结束后推送的 session_snapshot ——
 *  worker.handleChatReply 把 result.usage / result.model 写进 SessionStore,
 *  master 缓存在 sessionSnapshots 里。所以这里展示的就是该 chat session
 *  自己最近一次回复的 token 消耗,跟 issue 执行的 session 互相独立。 */
function SessionUsageLine({ entry }: { entry: SessionEntry }) {
  const [usage, setUsage] = useState<SessionUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    sessionsApi
      .usage(entry.cliTool, entry.groupId, entry.sessionId)
      .then((u) => { if (!cancelled) setUsage(u) })
      .catch(() => { if (!cancelled) setUsage(null) })
    return () => { cancelled = true }
  }, [entry.cliTool, entry.groupId, entry.sessionId])

  if (!usage || (!usage.usage && !usage.model)) {
    return <span className={`${styles.sessionUsage} ${styles.sessionUsageEmpty}`}>—</span>
  }

  const u: TokenUsage | null = usage.usage
  const hasUsage = !!u && (
    u.inputTokens != null
    || u.outputTokens != null
    || u.cacheReadTokens != null
    || u.cacheCreationTokens != null
    || u.totalCostUsd != null
  )
  const cumCost = usage.cumulativeCostUsd
  const showCumCost = typeof cumCost === "number" && cumCost > 0
  const cumIn = usage.cumulativeInputTokens
  const cumOut = usage.cumulativeOutputTokens
  const showCumTokens =
    (typeof cumIn === "number" && cumIn > 0) ||
    (typeof cumOut === "number" && cumOut > 0)

  return (
    <span className={styles.sessionUsage} title={buildSessionTooltip(usage)}>
      {usage.model && (
        <span className={styles.sessionUsageModel}>{shortModel(usage.model)}</span>
      )}
      {hasUsage && u && (
        <>
          {usage.model && <span className={styles.sessionUsageSep}>·</span>}
          {u.totalCostUsd != null && u.totalCostUsd > 0 && (
            <span className={styles.sessionUsageCost} title="本次 turn 成本 (USD)">
              ${formatCost(u.totalCostUsd)}
            </span>
          )}
        </>
      )}
      {showCumTokens && (
        <>
          {(hasUsage && u && u.totalCostUsd != null && u.totalCostUsd > 0 || usage.model) && <span className={styles.sessionUsageSep}>·</span>}
          {typeof cumIn === "number" && cumIn > 0 && (
            <span className={styles.sessionUsageTokenIn} title="累计输入 tokens (跨该 session 所有 turn)">
              <span className={styles.sessionUsageArrow}>↑</span>{formatTokens(cumIn)}
            </span>
          )}
          {typeof cumOut === "number" && cumOut > 0 && (
            <span className={styles.sessionUsageTokenOut} title="累计输出 tokens (跨该 session 所有 turn)">
              <span className={styles.sessionUsageArrow}>↓</span>{formatTokens(cumOut)}
            </span>
          )}
        </>
      )}
      {showCumCost && (
        <>
          <span className={styles.sessionUsageSep}>·</span>
          <span className={styles.sessionUsageCostCum} title="累计成本 (USD, 跨该 session 所有 turn)">
            Σ${formatCost(cumCost!)}
          </span>
        </>
      )}
    </span>
  )
}

function buildSessionTooltip(usage: SessionUsage): string {
  const parts: string[] = []
  if (usage.model) parts.push(`模型: ${usage.model}`)
  const u = usage.usage
  if (u) {
    if (u.inputTokens != null) parts.push(`输入(本次): ${u.inputTokens.toLocaleString()}`)
    if (u.outputTokens != null) parts.push(`输出(本次): ${u.outputTokens.toLocaleString()}`)
    if (u.cacheReadTokens != null) parts.push(`缓存读(本次): ${u.cacheReadTokens.toLocaleString()}`)
    if (u.cacheCreationTokens != null) parts.push(`缓存写(本次): ${u.cacheCreationTokens.toLocaleString()}`)
    if (u.totalCostUsd != null) parts.push(`本次成本: $${u.totalCostUsd.toFixed(6)}`)
  }
  if (typeof usage.cumulativeInputTokens === "number" && usage.cumulativeInputTokens > 0) {
    parts.push(`累计输入: ${usage.cumulativeInputTokens.toLocaleString()}`)
  }
  if (typeof usage.cumulativeOutputTokens === "number" && usage.cumulativeOutputTokens > 0) {
    parts.push(`累计输出: ${usage.cumulativeOutputTokens.toLocaleString()}`)
  }
  if (typeof usage.cumulativeCacheReadTokens === "number" && usage.cumulativeCacheReadTokens > 0) {
    parts.push(`累计缓存读: ${usage.cumulativeCacheReadTokens.toLocaleString()}`)
  }
  if (typeof usage.cumulativeCacheCreationTokens === "number" && usage.cumulativeCacheCreationTokens > 0) {
    parts.push(`累计缓存写: ${usage.cumulativeCacheCreationTokens.toLocaleString()}`)
  }
  if (typeof usage.cumulativeCostUsd === "number" && usage.cumulativeCostUsd > 0) {
    parts.push(`累计成本: $${usage.cumulativeCostUsd.toFixed(6)}`)
  }
  return parts.join(' · ') || '无 usage 数据'
}

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

function shortModel(model: string): string {
  const stripped = model.replace(/^(claude|anthropic|openai|gpt|gemini)-/i, '')
  if (stripped.length <= 22) return stripped
  return stripped.slice(0, 21) + '…'
}

interface SessionViewModalProps {
  entry: SessionEntry | null
  onClose: () => void
}

function SessionViewModal({ entry, onClose }: SessionViewModalProps) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; content: string; error?: string } | { kind: 'error'; message: string }
  >({ kind: 'loading' })

  useEffect(() => {
    if (!entry) return
    setState({ kind: 'loading' })
    sessionsApi
      .view(entry.cliTool, entry.groupId, entry.sessionId, 200)
      .then((resp) => {
        setState({ kind: 'ready', content: resp.content, error: resp.error })
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setState({ kind: 'error', message: msg })
      })
  }, [entry])

  if (!entry) return null

  const copy = () => {
    if (state.kind !== 'ready') return
    void navigator.clipboard.writeText(state.content).catch(() => {
      /* ignore — clipboard may be blocked in some contexts */
    })
  }

  return (
    <Modal
      open={!!entry}
      title={`${entry.agentName ?? entry.cliTool} · ${entry.sessionId.slice(0, 8)}…`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={copy} disabled={state.kind !== 'ready'}>
            复制
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {state.kind === 'loading' && <div className={styles.hint}>读取中…</div>}
      {state.kind === 'error' && (
        <div className={styles.hint}>读取失败：{state.message}</div>
      )}
      {state.kind === 'ready' && (
        <>
          {state.error && (
            <div className={styles.hint} style={{ marginBottom: 8 }}>
              {state.error}
            </div>
          )}
          <pre className={styles.sessionContent}>
            {state.content || '(空)'}
          </pre>
        </>
      )}
    </Modal>
  )
}
