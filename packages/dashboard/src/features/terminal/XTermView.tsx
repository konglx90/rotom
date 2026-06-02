/**
 * xterm.js view wired to the master's /api/terminal WebSocket. Owns the term
 * instance, the WS, and the ResizeObserver, but is intentionally agnostic to
 * how the URL is built — callers pass `url` and bump `connectToken` to force
 * a reconnect. Used by both the group-bound TerminalPane and the standalone
 * TerminalPage.
 *
 * No auto-reconnect: a stale ws drag would silently leave pty processes
 * lingering. Reconnect is exposed via the connectToken prop so callers can
 * gate it behind an explicit user action.
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import styles from './XTermView.module.css'

export type TerminalStatus = 'connecting' | 'open' | 'closed'

interface XTermViewProps {
  url: string
  /** Bump to force a reconnect (e.g. user clicks 重连). */
  connectToken: number
  onStatusChange?: (status: TerminalStatus) => void
  className?: string
  style?: React.CSSProperties
}

export function XTermView({ url, connectToken, onStatusChange, className, style }: XTermViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

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

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    onStatusChange?.('connecting')
    term.writeln('\x1b[90m[正在连接终端…]\x1b[0m')

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      onStatusChange?.('open')
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
      onStatusChange?.('closed')
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
  }, [url, connectToken, onStatusChange])

  // Refit on container size changes and broadcast new dimensions to the pty.
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
        // viewport. Snap to bottom so the most recent line stays visible.
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

  return (
    <div
      ref={containerRef}
      className={`${styles.term} ${className ?? ''}`}
      style={style}
    />
  )
}
