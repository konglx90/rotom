/**
 * Embedded web terminal — wraps XTermView with collapse/expand chrome that
 * sits at the bottom of ArtifactPanel. The shell runs in the group's
 * working_dir (resolved on the server from groupId).
 */

import { useCallback, useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { XTermView, type TerminalStatus } from '../terminal/XTermView'
import { groupTerminalUrl } from '../terminal/terminalUrl'
import styles from './TerminalPane.module.css'

interface TerminalPaneProps {
  groupId: string
}

export function TerminalPane({ groupId }: TerminalPaneProps) {
  // Bumping this triggers the connect effect inside XTermView (used by "重连").
  const [connectToken, setConnectToken] = useState(0)
  const [collapsed, setCollapsed] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<TerminalStatus>('closed')

  const url = useMemo(() => groupTerminalUrl(groupId), [groupId])

  const handleReconnect = useCallback(() => {
    setConnectToken((n) => n + 1)
  }, [])

  const statusLabel =
    status === 'open' ? '● 已连接' : status === 'connecting' ? '○ 连接中' : '× 已断开'
  const statusClass =
    status === 'open' ? styles.statusOk : status === 'connecting' ? styles.statusPending : styles.statusBad

  return (
    <div
      className={`${styles.terminalPane} ${collapsed ? styles.collapsed : ''} ${expanded ? styles.expanded : ''}`}
    >
      <div className={styles.header}>
        <span className={styles.title}>终端</span>
        <span className={`${styles.status} ${statusClass}`}>{statusLabel}</span>
        <div className={styles.actions}>
          {status !== 'open' && (
            <Button variant="ghost" size="sm" onClick={handleReconnect}>
              重连
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            disabled={collapsed}
            title={expanded ? '恢复默认高度' : '放大终端'}
          >
            {expanded ? '缩小' : '放大'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开终端' : '折叠终端'}
          >
            {collapsed ? '展开' : '折叠'}
          </Button>
        </div>
      </div>
      {!collapsed && (
        <XTermView
          url={url}
          connectToken={connectToken}
          onStatusChange={setStatus}
        />
      )}
    </div>
  )
}
