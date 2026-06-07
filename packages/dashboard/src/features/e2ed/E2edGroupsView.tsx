/**
 * E2edGroupsView — Requirement list page for E2ED delivery.
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { e2edApi, type E2edRequirement } from '../../api/e2ed'

const STATUS_COLORS: Record<string, string> = {
  CREATED: '#6b7280',
  ENV_CHECKING: '#f59e0b',
  ENV_READY: '#10b981',
  REQ_REVIEWING: '#3b82f6',
  REQ_REVIEWED: '#10b981',
  PLANNING: '#8b5cf6',
  PLAN_REVIEWING: '#3b82f6',
  PLAN_REVIEWED: '#10b981',
  DELIVERING: '#f59e0b',
  DELIVERED: '#10b981',
  REVIEWING: '#3b82f6',
  REVIEWED: '#10b981',
  CLOSED: '#6b7280',
}

const POLL_INTERVAL = 3000

export function E2edGroupsView() {
  const navigate = useNavigate()
  const [reqs, setReqs] = useState<E2edRequirement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createText, setCreateText] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const fetchReqs = useCallback(() => {
    e2edApi.list()
      .then((data) => { setReqs(data); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Initial load + polling
  useEffect(() => {
    fetchReqs()
    const timer = setInterval(fetchReqs, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [fetchReqs])

  const handleCreate = async () => {
    if (!createText.trim()) return
    setCreating(true)
    try {
      await e2edApi.create({
        title: createTitle.trim() || undefined,
        text: createText.trim(),
      })
      setCreateText('')
      setCreateTitle('')
      setShowCreate(false)
      fetchReqs()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setCreating(false)
    }
  }

  if (loading) return <div style={{ padding: 24, color: '#888' }}>Loading...</div>
  if (error) return <div style={{ padding: 24, color: 'red' }}>Error: {error}</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>E2ED 交付需求</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            padding: '6px 16px', border: 'none', borderRadius: 6,
            background: '#3b82f6', color: '#fff', fontSize: 13,
            fontWeight: 500, cursor: 'pointer',
          }}
        >
          {showCreate ? '取消' : '+ 创建需求'}
        </button>
      </div>

      {showCreate && (
        <div style={{
          padding: 16, marginBottom: 16, border: '1px solid #e5e7eb',
          borderRadius: 8, background: '#f9fafb',
        }}>
          <input
            placeholder="标题（可选）"
            value={createTitle}
            onChange={(e) => setCreateTitle(e.target.value)}
            style={{
              width: '100%', padding: '8px 12px', marginBottom: 8,
              border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14,
              boxSizing: 'border-box',
            }}
          />
          <textarea
            placeholder="需求描述（Markdown）"
            value={createText}
            onChange={(e) => setCreateText(e.target.value)}
            rows={4}
            style={{
              width: '100%', padding: '8px 12px', marginBottom: 8,
              border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14,
              boxSizing: 'border-box', resize: 'vertical',
            }}
          />
          <button
            onClick={handleCreate}
            disabled={creating || !createText.trim()}
            style={{
              padding: '6px 20px', border: 'none', borderRadius: 6,
              background: creating ? '#9ca3af' : '#10b981', color: '#fff',
              fontSize: 13, fontWeight: 500, cursor: creating ? 'not-allowed' : 'pointer',
            }}
          >
            {creating ? '创建中...' : '创建'}
          </button>
        </div>
      )}

      {reqs.length === 0 ? (
        <div style={{ color: '#888' }}>
          No requirements yet. Click <strong>"+ 创建需求"</strong> above, or use:{' '}
          <code>rotom e2ed start requirement.md</code>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>ID</th>
              <th style={{ padding: '8px 12px' }}>Status</th>
              <th style={{ padding: '8px 12px' }}>Version</th>
              <th style={{ padding: '8px 12px' }}>Plans</th>
              <th style={{ padding: '8px 12px' }}>Code</th>
              <th style={{ padding: '8px 12px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {reqs.map((r) => (
              <tr
                key={r.reqId}
                onClick={() => navigate(`/dashboard/e2ed/${r.reqId}`)}
                style={{
                  borderBottom: '1px solid #f3f4f6',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#f9fafb')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '')}
              >
                <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{r.reqId.slice(0, 8)}...</td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{
                    background: STATUS_COLORS[r.status] || '#6b7280',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                  }}>
                    {r.status}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{r.compositeVersion}</td>
                <td style={{ padding: '8px 12px' }}>{r.planVersions?.length || 0}</td>
                <td style={{ padding: '8px 12px' }}>{r.codeVersions?.length || 0}</td>
                <td style={{ padding: '8px 12px', color: '#6b7280' }}>
                  {r.timeline?.[0]?.at ? new Date(r.timeline[0].at).toLocaleDateString() : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
