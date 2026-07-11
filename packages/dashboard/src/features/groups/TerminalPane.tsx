/**
 * Embedded web terminal — wraps XTermView with collapse/expand chrome that
 * sits at the bottom of ArtifactPanel. The shell runs in the group's
 * working_dir (resolved on the server from groupId).
 *
 * Expand/collapse is driven by the shared TerminalDeckContext: expanding this
 * pane marks the group's terminal "open", so it also appears in the global
 * deck (and vice-versa — closing it anywhere closes it here too). XTermView
 * auto-reconnects, so there's no manual "重连" button.
 */

import { useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { XTermView, type TerminalStatus } from '../terminal/XTermView'
import { groupTerminalUrl } from '../terminal/terminalUrl'
import { useTerminalDeck } from '../terminal/TerminalDeckContext'
import styles from './TerminalPane.module.css'

interface TerminalPaneProps {
  groupId: string
}

export function TerminalPane({ groupId }: TerminalPaneProps) {
  const { isTerminalOpen, openTerminal, closeTerminal } = useTerminalDeck()
  const expanded = isTerminalOpen(groupId)
  const [status, setStatus] = useState<TerminalStatus>('closed')

  const url = useMemo(() => groupTerminalUrl(groupId), [groupId])

  const statusLabel =
    status === 'open' ? '● 已连接' : status === 'connecting' ? '○ 连接中' : '× 已断开'
  const statusClass =
    status === 'open' ? styles.statusOk : status === 'connecting' ? styles.statusPending : styles.statusBad

  return (
    <div className={`${styles.terminalPane} ${expanded ? '' : styles.collapsed}`}>
      <div className={styles.header}>
        <span className={styles.title}>终端</span>
        {expanded && <span className={`${styles.status} ${statusClass}`}>{statusLabel}</span>}
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (expanded ? closeTerminal(groupId) : openTerminal(groupId))}
            title={expanded ? '关闭终端(同时从全局面板移除)' : '连接终端(占面板一半,并加入全局面板)'}
          >
            {expanded ? '关闭' : '连接'}
          </Button>
        </div>
      </div>
      {expanded && (
        <XTermView url={url} connectToken={0} onStatusChange={setStatus} />
      )}
    </div>
  )
}
