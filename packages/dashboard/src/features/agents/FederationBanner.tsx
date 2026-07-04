import { useEffect, useState } from 'react'

interface TeamInfo {
  teamName: string
  coordDashboardUrl: string
}

/**
 * 联邦入口 banner:本机如果接入了大团队(member 模式),显示一个跳转入口,
 * 点击新窗口打开协调 master 的 dashboard。
 * standalone / coordination 模式不显示。
 */
export function FederationBanner() {
  const [info, setInfo] = useState<TeamInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/identity').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
    ]).then(([id, teams]) => {
      if (cancelled) return
      if (id.role !== 'member') return
      const team = teams[0]
      if (!team || !team.coordEndpoints?.length) return
      // ws://host:port → http://host:port/dashboard/agents
      const wsUrl = team.coordEndpoints[0]
      const httpUrl = wsUrl
        .replace(/^wss:/, 'https:')
        .replace(/^ws:/, 'http:')
        .replace(/\/$/, '') + '/dashboard/agents'
      setInfo({
        teamName: team.name,
        coordDashboardUrl: httpUrl,
      })
    }).catch(() => { /* 静默 — banner 不显示即可 */ })
    return () => { cancelled = true }
  }, [])

  if (!info) return null

  return (
    <a
      href={info.coordDashboardUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        marginBottom: 12,
        background: 'var(--color-primary-bg, #eef2ff)',
        border: '1px solid var(--color-primary, #6366f1)',
        borderRadius: 6,
        color: 'var(--color-primary, #6366f1)',
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <span style={{ fontSize: 16 }}>🌐</span>
      <span>已接入「{info.teamName}」大团队</span>
      <span style={{ marginLeft: 'auto', opacity: 0.8 }}>查看大团队 dashboard →</span>
    </a>
  )
}
