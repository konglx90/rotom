import { useEffect, useState } from 'react'

interface MasterIdentity {
  id: string
  hostname: string
  role: 'standalone' | 'coordination' | 'member'
  displayName?: string | null
  teamName: string
  endpoint?: string | null
  federationEnabled: boolean
}

interface Team {
  id: string
  name: string
  description?: string | null
  myRole: 'coordination' | 'member'
  coordEndpoints: string[]
  joinedAt: string
}

interface TeamMember {
  masterId: string
  hostname: string
  name: string
  displayName?: string | null
  isHuman: boolean
  online: boolean
  lastHeartbeat?: string | null
  ref: string
}

export function TeamsView() {
  const [identity, setIdentity] = useState<MasterIdentity | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [members, setMembers] = useState<Record<string, TeamMember[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 加入上级团队表单状态
  const [coordEndpoint, setCoordEndpoint] = useState('')
  const [teamName, setTeamName] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState('')

  const refresh = async () => {
    const [id, ts] = await Promise.all([
      fetch('/api/identity').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
    ])
    setIdentity(id)
    setTeams(ts)
    const memberMap: Record<string, TeamMember[]> = {}
    for (const t of ts) {
      const r = await fetch(`/api/teams/${t.id}/members`)
      memberMap[t.id] = await r.json()
    }
    setMembers(memberMap)
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message)).finally(() => setLoading(false))
  }, [])

  const handleJoin = async () => {
    setJoining(true)
    setJoinError('')
    try {
      const res = await fetch('/api/teams/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordEndpoint: coordEndpoint.trim(), teamName: teamName.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        setJoinError(data.error || `HTTP ${res.status}`)
      } else {
        setCoordEndpoint('')
        setTeamName('')
        await refresh()
      }
    } catch (err) {
      setJoinError((err as Error).message)
    } finally {
      setJoining(false)
    }
  }

  const handleLeave = async () => {
    if (!window.confirm('确定离开当前大团队,切回 standalone 模式?')) return
    try {
      const res = await fetch('/api/teams/leave', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || data.error) {
        alert(data.error || `HTTP ${res.status}`)
      } else {
        await refresh()
      }
    } catch (err) {
      alert((err as Error).message)
    }
  }

  if (loading) return <div style={{ padding: 24 }}>加载中...</div>
  if (error) return <div style={{ padding: 24, color: 'var(--color-error)' }}>错误: {error}</div>
  if (!identity) return <div style={{ padding: 24 }}>无法获取 master 身份</div>

  const isMember = identity.role === 'member' || teams.some(t => t.myRole === 'member')

  return (
    <div style={{ padding: 24, maxWidth: 900 }}>
      <h2 style={{ marginBottom: 16 }}>团队</h2>

      <section style={{
        padding: 16,
        marginBottom: 24,
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        background: 'var(--color-surface)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>本机 master</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 13 }}>
          <span style={{ color: 'var(--color-text-secondary)' }}>团队名</span>
          <span style={{ fontWeight: 500 }}>{identity.teamName}</span>
          <span style={{ color: 'var(--color-text-secondary)' }}>masterId</span>
          <code style={{ fontFamily: 'ui-monospace, monospace' }}>{identity.id}</code>
          <span style={{ color: 'var(--color-text-secondary)' }}>hostname</span>
          <span>{identity.hostname}</span>
          <span style={{ color: 'var(--color-text-secondary)' }}>role</span>
          <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 4,
            background: identity.role === 'standalone' ? 'var(--color-tag-bg)' : 'var(--color-primary-bg)',
            color: identity.role === 'standalone' ? 'var(--color-text-secondary)' : 'var(--color-primary)',
            fontSize: 12,
            fontWeight: 500,
          }}>{identity.role}</span>
          <span style={{ color: 'var(--color-text-secondary)' }}>federation</span>
          <span>{identity.federationEnabled ? '已启用' : '未启用'}</span>
        </div>
        {identity.role === 'standalone' && !isMember && (
          <div style={{ marginTop: 12, padding: 16, background: 'var(--color-warning-bg)', borderRadius: 4, fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>💡 加入上级团队</div>
            <div style={{ marginBottom: 8, color: 'var(--color-text-secondary)' }}>
              填入协调 master 的地址(ws://host:port),点击加入。协调 master 需先以 coordination 模式启动。
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="ws://192.168.1.5:28800"
                value={coordEndpoint}
                onChange={(e) => setCoordEndpoint(e.target.value)}
                style={{
                  flex: 1, minWidth: 220, padding: '6px 10px',
                  border: '1px solid var(--color-border)', borderRadius: 4,
                  fontFamily: 'ui-monospace, monospace', fontSize: 12,
                }}
              />
              <input
                type="text"
                placeholder="团队名(可选,默认=本机团队名)"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                style={{
                  flex: 1, minWidth: 180, padding: '6px 10px',
                  border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 12,
                }}
              />
              <button
                onClick={handleJoin}
                disabled={!coordEndpoint.trim() || joining}
                style={{
                  padding: '6px 16px',
                  background: !coordEndpoint.trim() || joining ? 'var(--color-text-tertiary)' : 'var(--color-primary)',
                  color: 'white',
                  border: 'none', borderRadius: 4, cursor: joining ? 'not-allowed' : 'pointer',
                  fontSize: 12, fontWeight: 500,
                }}
              >
                {joining ? '加入中...' : '加入'}
              </button>
            </div>
            {joinError && (
              <div style={{ marginTop: 8, color: 'var(--color-error)', fontSize: 12 }}>❌ {joinError}</div>
            )}
          </div>
        )}
        {isMember && (
          <div style={{ marginTop: 12, padding: 12, background: 'var(--color-success-bg, #f0fdf4)', borderRadius: 4, fontSize: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>✅ 已接入上级团队</span>
            <button
              onClick={handleLeave}
              style={{
                marginLeft: 'auto', padding: '4px 12px',
                background: 'transparent',
                color: 'var(--color-error)',
                border: '1px solid var(--color-error)', borderRadius: 4,
                cursor: 'pointer', fontSize: 12,
              }}
            >
              离开团队
            </button>
          </div>
        )}
      </section>

      {teams.length === 0 ? (
        <section style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
          尚未加入任何团队。
        </section>
      ) : (
        teams.map(t => (
          <section key={t.id} style={{
            padding: 16,
            marginBottom: 16,
            border: '1px solid var(--color-border)',
            borderRadius: 8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>{t.name}</div>
              <code style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{t.id}</code>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
              我在团队里的角色:<strong>{t.myRole}</strong> · 协调 master:{t.coordEndpoints.join(', ')}
            </div>

            <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 8 }}>
              团队成员({(members[t.id] || []).length})
            </div>
            {(members[t.id] || []).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>暂无可见 agent</div>
            ) : (
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)', fontSize: 11 }}>
                    <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--color-border)' }}>名称</th>
                    <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--color-border)' }}>hostname</th>
                    <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--color-border)' }}>masterId</th>
                    <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--color-border)' }}>类型</th>
                    <th style={{ padding: '4px 8px', borderBottom: '1px solid var(--color-border)' }}>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {(members[t.id] || []).map(m => (
                    <tr key={`${m.masterId}:${m.name}`}>
                      <td style={{ padding: '6px 8px' }}>
                        {m.isHuman ? '👤 ' : '🚀 '}
                        {m.displayName || m.name}
                      </td>
                      <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }}>
                        {m.hostname}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <code style={{ fontSize: 11 }}>{m.masterId}</code>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {m.isHuman ? '真人' : 'Agent'}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{
                          display: 'inline-block',
                          width: 8, height: 8, borderRadius: '50%',
                          background: m.online ? 'var(--color-success)' : 'var(--color-text-tertiary)',
                          marginRight: 6,
                        }} />
                        {m.online ? '在线' : '离线'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))
      )}
    </div>
  )
}
