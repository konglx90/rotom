/**
 * xterm.js view wired to the master's /api/terminal WebSocket. Owns the term
 * instance, the WS, and the ResizeObserver, but is intentionally agnostic to
 * how the URL is built — callers pass `url` and bump `connectToken` to force
 * a reconnect. Used by both the group-bound TerminalPane and the standalone
 * TerminalPage.
 *
 * The server keys PTYs by a stable tid, so reconnecting (or remounting) to the
 * same url reattaches to the still-alive shell and replays its scrollback. The
 * server's buffer is the single source of truth: on open we reset the term so
 * the replay fills a clean buffer instead of stacking on stale local output.
 *
 * Auto-reconnect: PTYs persist server-side, so a dropped WS is safe to retry —
 * reattaching is idempotent. On close we back off (1s → 15s cap) and reconnect
 * automatically, so no manual "重连" button is needed. `connectToken` remains
 * for callers that want to force a fresh connection (e.g. picking a new cwd).
 */

import { useEffect, useRef, useState } from 'react'
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
  // Auto-reconnect bookkeeping. autoToken bumps to retrigger the connect
  // effect; attemptRef drives exponential backoff and resets on a successful
  // open; reconnectTimerRef is cleared on cleanup. Per-effect `cancelled`
  // (declared inside the effect) suppresses a reconnect scheduled by the
  // async close of a WS that was already torn down.
  const [autoToken, setAutoToken] = useState(0)
  const attemptRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)

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
    let cancelled = false
    onStatusChange?.('connecting')
    term.writeln(
      attemptRef.current === 0
        ? '\x1b[90m[正在连接终端…]\x1b[0m'
        : '\x1b[90m[重连中…]\x1b[0m',
    )

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      attemptRef.current = 0
      onStatusChange?.('open')
      // The server replays the PTY's scrollback to a reattaching viewer, and
      // that buffer is the source of truth. Reset the term so the replay
      // lands on a clean slate instead of doubling up on local output.
      term.reset()
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
      // PTYs persist server-side, so reconnecting is safe (reattach is
      // idempotent). Back off so a down server doesn't hammer. Suppress when
      // this WS was torn down by cleanup (re-run or unmount) — its async close
      // must not trigger a duplicate reconnect.
      if (cancelled) return
      const delay = Math.min(1000 * 2 ** attemptRef.current, 15000)
      attemptRef.current += 1
      term.writeln(`\r\n\x1b[90m[连接已断开 — ${(delay / 1000).toFixed(0)}s 后自动重连]\x1b[0m`)
      reconnectTimerRef.current = window.setTimeout(() => setAutoToken((n) => n + 1), delay)
    }
    ws.onerror = () => {
      // onclose will fire too; avoid double-logging
    }

    const inputSub = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'input', data }))
    })

    return () => {
      cancelled = true
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      inputSub.dispose()
      try { ws.close() } catch { /* ignore */ }
      wsRef.current = null
    }
  }, [url, connectToken, autoToken, onStatusChange])

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
