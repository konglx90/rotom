/**
 * URL builders for the master's /api/terminal WebSocket. Mirrors the
 * dev/prod host logic in SocketContext: in dev (vite:3000) the master still
 * listens on :18800, in prod the dashboard is served from the same origin.
 */

function terminalBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname === 'localhost'
    ? 'localhost:18800'
    : `${window.location.hostname}:18800`
  return `${proto}//${host}/api/terminal`
}

export function groupTerminalUrl(groupId: string): string {
  return `${terminalBaseUrl()}?groupId=${encodeURIComponent(groupId)}`
}

export function cwdTerminalUrl(cwd: string): string {
  return `${terminalBaseUrl()}?cwd=${encodeURIComponent(cwd)}`
}
