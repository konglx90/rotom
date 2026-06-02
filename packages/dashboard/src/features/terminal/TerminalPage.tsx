/**
 * Standalone terminal page — not tied to a chat group. The user picks a
 * working directory and gets a shell rooted there.
 *
 * Directory source priority:
 *   1. ?cwd= query param (shareable links)
 *   2. localStorage (last connected directory)
 *   3. empty (user must enter one)
 *
 * The directory the user types is kept in `pendingCwd`; only the directory
 * the WS is actually connected with sits in `activeCwd`. This keeps the
 * input from yanking the shell out from under in-flight commands while the
 * user is mid-typing a new path.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { XTermView, type TerminalStatus } from './XTermView'
import { cwdTerminalUrl } from './terminalUrl'
import styles from './TerminalPage.module.css'

const STORAGE_KEY = 'terminal_page_cwd'

function readStoredCwd(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStoredCwd(cwd: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, cwd)
  } catch { /* ignore quota / private-mode */ }
}

export function TerminalPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryCwd = searchParams.get('cwd') ?? ''

  const initialCwd = useMemo(() => queryCwd || readStoredCwd(), [queryCwd])
  const [pendingCwd, setPendingCwd] = useState(initialCwd)
  const [activeCwd, setActiveCwd] = useState(initialCwd)
  const [connectToken, setConnectToken] = useState(0)
  const [status, setStatus] = useState<TerminalStatus>('connecting')

  // Sync the input when the URL changes from underneath us (e.g. user clicks
  // a different ?cwd link). Don't touch the active connection — they have to
  // confirm via 连接 so a casual nav can't disturb a running shell.
  useEffect(() => {
    if (queryCwd && queryCwd !== pendingCwd) {
      setPendingCwd(queryCwd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryCwd])

  const handleConnect = useCallback(() => {
    const cwd = pendingCwd.trim()
    if (!cwd) return
    writeStoredCwd(cwd)
    // Reflect the chosen directory in the URL so the page is shareable.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('cwd', cwd)
      return next
    }, { replace: true })
    setActiveCwd(cwd)
    // Force a fresh WS even if cwd is unchanged — same semantics as 重连.
    setConnectToken((n) => n + 1)
  }, [pendingCwd, setSearchParams])

  const url = useMemo(() => (activeCwd ? cwdTerminalUrl(activeCwd) : null), [activeCwd])

  const statusLabel =
    status === 'open' ? '● 已连接' : status === 'connecting' ? '○ 连接中' : '× 已断开'
  const statusClass =
    status === 'open' ? styles.statusOk : status === 'connecting' ? styles.statusPending : styles.statusBad

  const buttonLabel = !activeCwd ? '连接' : status === 'open' ? '切换目录' : '重连'

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <span className={styles.title}>终端</span>
        <input
          type="text"
          placeholder="/绝对/路径/到/工作目录"
          value={pendingCwd}
          onChange={(e) => setPendingCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleConnect()
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={styles.cwdInput}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleConnect}
          disabled={!pendingCwd.trim()}
        >
          {buttonLabel}
        </Button>
        {activeCwd && (
          <span className={`${styles.status} ${statusClass}`}>{statusLabel}</span>
        )}
      </div>
      {url ? (
        <XTermView
          url={url}
          connectToken={connectToken}
          onStatusChange={setStatus}
          className={styles.term}
        />
      ) : (
        <div className={styles.empty}>
          <p>输入一个绝对路径并点「连接」打开 shell。</p>
          <p className={styles.emptyHint}>shell 会以 master 进程的身份在该目录启动。</p>
        </div>
      )}
    </div>
  )
}
