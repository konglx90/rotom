/**
 * URL builders for the master's /api/terminal WebSocket. 走同源:与 SocketContext
 * 一致 —— dev 下由 vite 代理 /api(含 ws 升级)到 master:28800,prod 下同源直连。
 * 这样从 Pad/局域网访问时只需打通加载页面的那一个端口。
 */

function terminalBaseUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/terminal`
}

export function groupTerminalUrl(groupId: string): string {
  return `${terminalBaseUrl()}?groupId=${encodeURIComponent(groupId)}`
}

export function cwdTerminalUrl(cwd: string): string {
  return `${terminalBaseUrl()}?cwd=${encodeURIComponent(cwd)}`
}
