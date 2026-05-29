/**
 * Embedded web terminal — xterm.js attached to the master's /api/terminal
 * WebSocket. Sits at the bottom of ArtifactPanel and runs commands in the
 * same cwd the artifact tree is reading from.
 *
 * Lifecycle:
 *   - mount  → create xterm + open WS
 *   - resize (ResizeObserver) → fit + send {type:resize}
 *   - data from server → write to xterm
 *   - data from xterm  → send {type:input}
 *   - unmount → close WS (server kills the pty)
 *
 * No auto-reconnect: a stale ws drag would silently leave pty processes
 * lingering. User-driven 重连 button keeps the lifecycle explicit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Button } from '../../components/ui/Button'
import styles from './TerminalPane.module.css'

interface TerminalPaneProps {
  groupId: string
}

type Status = 'connecting' | 'open' | 'closed'

function resolveTerminalUrl(groupId: string): string {
  // Mirrors SocketContext: in dev (vite:3000) the master still listens on
  // :18800, in prod the dashboard is served from the same origin.
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname === 'localhost'
    ? 'localhost:18800'
    : `${window.location.hostname}:18800`
  return `${proto}//${host}/api/terminal?groupId=${encodeURIComponent(groupId)}`
}

export function TerminalPane({ groupId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Bumping this triggers the connect effect (used by "重连").
  const [connectToken, setConnectToken] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<Status>('connecting')

  // Initialize xterm once per mount. Re-creating it across reconnects
  // would lose the scrollback the user just looked at.
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#1e1e1e',
        foreground: '#e4e4e4',
        cursor: '#9fe870',
        selectionBackground: 'rgba(159, 232, 112, 0.35)',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    try { fit.fit() } catch { /* container may be 0×0 on first paint */ }
    termRef.current = term
    fitRef.current = fit

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Connect WS — re-runs when groupId changes or user clicks 重连.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    setStatus('connecting')
    term.writeln('\x1b[90m[正在连接终端…]\x1b[0m')

    const ws = new WebSocket(resolveTerminalUrl(groupId))
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('open')
      // Send initial size before any input — server pty starts at 80×24
      // otherwise.
      const fit = fitRef.current
      try {
        fit?.fit()
        const dims = fit?.proposeDimensions()
        if (dims) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
        }
      } catch { /* ignore */ }
    }

    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: string; message?: string; code?: number | null }
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data)
      } else if (msg.type === 'exit') {
        term.writeln(`\r\n\x1b[90m[shell 已退出 code=${msg.code ?? '?'}]\x1b[0m`)
      } else if (msg.type === 'error' && typeof msg.message === 'string') {
        term.writeln(`\r\n\x1b[31m[错误] ${msg.message}\x1b[0m`)
      }
    }

    ws.onclose = () => {
      setStatus('closed')
      term.writeln('\r\n\x1b[90m[连接已断开 — 点「重连」恢复]\x1b[0m')
    }
    ws.onerror = () => {
      // onclose will fire too; avoid double-logging
    }

    const inputSub = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'input', data }))
    })

    return () => {
      inputSub.dispose()
      try { ws.close() } catch { /* ignore */ }
      wsRef.current = null
    }
  }, [groupId, connectToken])

  // Refit on container size changes (panel collapse, window resize, etc.)
  // and broadcast new dimensions to the pty.
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => {
      const term = termRef.current
      const fit = fitRef.current
      const ws = wsRef.current
      if (!fit || !term) return
      try {
        fit.fit()
        // After a fit the cursor row may temporarily sit below the new
        // viewport (e.g. user expanded the pane mid-output, or the parent
        // flex layout just gave us fewer rows). Snap to bottom so the most
        // recent line is always visible.
        term.scrollToBottom()
        const dims = fit.proposeDimensions()
        if (dims && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
        }
      } catch { /* ignore */ }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

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
      <div
        ref={containerRef}
        className={styles.term}
        // xterm reads the actual element size via FitAddon; CSS controls
        // height via parent class (collapsed/expanded). hidden when collapsed
        // to avoid the dark void at the bottom.
        style={collapsed ? { display: 'none' } : undefined}
      />
    </div>
  )
}
