import { useEffect, useRef, useState, useCallback } from 'react'
import { sessionsApi, type SessionEntry } from '../../api/sessions'
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
 * Per-group session list. For each backend (claude/codex/hermes/openclaw) that
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
      const ok = window.confirm(
        `确定删除 ${entry.cliTool} 在该群的 session?\n${entry.sessionId}\n\n下次对话将重新开始。`,
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
          触发一次对话后,各后端(claude / codex / hermes / openclaw)会自动登记 sessionId。
        </div>
      </div>
    )
  }

  return (
    <div className={styles.sessionPanel}>
      {state.sessions.map((entry) => {
        const key = `${entry.cliTool}:${entry.sessionId}`
        const isDeleting = deleting === key
        return (
          <div key={key} className={styles.sessionRow}>
            <div className={styles.sessionCliTag} title={entry.cliTool}>
              {entry.cliTool}
            </div>
            <div className={styles.sessionId} title={entry.sessionId}>
              {entry.sessionId.length > 14
                ? `${entry.sessionId.slice(0, 6)}…${entry.sessionId.slice(-4)}`
                : entry.sessionId}
            </div>
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
      title={`${entry.cliTool} · ${entry.sessionId.slice(0, 8)}…`}
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
