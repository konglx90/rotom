/**
 * E2edSidebar — Dedicated sidebar for E2ED requirement pages.
 *
 * Wise-inspired design: Lime Green accent, pill buttons, Inter font.
 */

import { useState, useEffect } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { e2edApi, type E2edRequirement } from '../../api/e2ed'

const GREEN = '#9fe870'
const DARK_GREEN = '#163300'
const NEAR_BLACK = '#0e0f0c'
const GRAY = '#868685'
const RING = 'rgba(14,15,12,0.12) 0px 0px 0px 1px'

const STATUS_DOT: Record<string, string> = {
  CREATED: '#868685',
  ENV_CHECKING: '#2563eb',
  ENV_READY: '#22c55e',
  REQ_REVIEWING: '#2563eb',
  REQ_REVIEWED: '#22c55e',
  PLANNING: '#7c3aed',
  PLAN_REVIEWING: '#2563eb',
  PLAN_REVIEWED: '#22c55e',
  DELIVERING: '#d97706',
  DELIVERED: '#22c55e',
  REVIEWING: '#2563eb',
  REVIEWED: '#22c55e',
  CLOSED: '#868685',
}

export function E2edSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const [reqs, setReqs] = useState<E2edRequirement[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [createText, setCreateText] = useState('')
  const [createTitle, setCreateTitle] = useState('')

  useEffect(() => {
    e2edApi.list().then(setReqs).catch(() => {})
    const timer = setInterval(() => e2edApi.list().then(setReqs).catch(() => {}), 5000)
    return () => clearInterval(timer)
  }, [])

  const selectedId = location.pathname.split('/e2ed/')[1]?.split('/')[0] || ''

  const handleCreate = async () => {
    if (!createText.trim()) return
    try {
      await e2edApi.create({ title: createTitle.trim() || undefined, text: createText.trim() })
      setCreateText(''); setCreateTitle(''); setShowCreate(false)
      e2edApi.list().then(setReqs)
    } catch (e: any) { alert(e.message) }
  }

  const activeReqs = reqs.filter(r => r.status !== 'CLOSED')
  const closedReqs = reqs.filter(r => r.status === 'CLOSED')

  return (
    <div style={{
      width: 300, minWidth: 300, height: '100%',
      background: '#fff', borderRight: '1px solid rgba(14,15,12,0.08)',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'Inter, -apple-system, sans-serif',
      fontFeatureSettings: '"calt"',
    }}>
      {/* ── Logo ─────────────────────────────────────── */}
      <Link to="/dashboard/e2ed" style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '20px 20px 16px', textDecoration: 'none',
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFeatureSettings: '"calt"',
          fontSize: 14, fontWeight: 900, color: DARK_GREEN,
        }}>E</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: NEAR_BLACK, letterSpacing: -0.3, fontFeatureSettings: '"calt"' }}>E2ED</div>
          <div style={{ fontSize: 11, color: GRAY, letterSpacing: 0.02 }}>端到端交付</div>
        </div>
      </Link>

      {/* ── Create Button ────────────────────────────── */}
      <div style={{ padding: '0 16px 16px' }}>
        {showCreate ? (
          <div style={{
            border: RING, borderRadius: 16, padding: 12,
          }}>
            <input placeholder="标题（可选）" value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              style={{ width: '100%', border: 'none', outline: 'none', fontSize: 13, fontWeight: 600, marginBottom: 8, color: NEAR_BLACK, fontFeatureSettings: '"calt"' }} />
            <textarea placeholder="需求描述..." value={createText}
              onChange={(e) => setCreateText(e.target.value)} rows={3}
              style={{ width: '100%', border: 'none', outline: 'none', fontSize: 13, resize: 'vertical', color: NEAR_BLACK, fontFeatureSettings: '"calt"' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button onClick={handleCreate}
                style={{
                  padding: '4px 14px', borderRadius: 9999, border: 'none',
                  background: GREEN, color: DARK_GREEN, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer', fontFeatureSettings: '"calt"',
                  transition: 'transform 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.05)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
              >创建</button>
              <button onClick={() => setShowCreate(false)}
                style={{ padding: '4px 14px', borderRadius: 9999, border: 'none', background: 'transparent', color: GRAY, fontSize: 13, cursor: 'pointer', fontFeatureSettings: '"calt"' }}
              >取消</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)}
            style={{
              width: '100%', padding: '8px 0', borderRadius: 9999, border: 'none',
              background: GREEN, color: DARK_GREEN, fontSize: 14, fontWeight: 600,
              cursor: 'pointer', fontFeatureSettings: '"calt"',
              transition: 'transform 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          >+ 新建需求</button>
        )}
      </div>

      {/* ── Requirement List ─────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {/* Active */}
        {activeReqs.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: GRAY, padding: '0 8px 6px', textTransform: 'uppercase', letterSpacing: 0.05, fontFeatureSettings: '"calt"' }}>
              进行中
            </div>
            {activeReqs.map((r) => (
              <ReqItem key={r.reqId} req={r} selected={r.reqId === selectedId} onClick={() => navigate(`/dashboard/e2ed/${r.reqId}`)} />
            ))}
          </div>
        )}

        {/* Closed */}
        {closedReqs.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: GRAY, padding: '0 8px 6px', textTransform: 'uppercase', letterSpacing: 0.05, fontFeatureSettings: '"calt"' }}>
              已完成
            </div>
            {closedReqs.map((r) => (
              <ReqItem key={r.reqId} req={r} selected={r.reqId === selectedId} onClick={() => navigate(`/dashboard/e2ed/${r.reqId}`)} dimmed />
            ))}
          </div>
        )}

        {reqs.length === 0 && (
          <div style={{ padding: '20px 12px', textAlign: 'center', fontSize: 13, color: GRAY, fontFeatureSettings: '"calt"' }}>
            点击上方按钮创建第一个需求
          </div>
        )}
      </div>

      {/* ── Back to Dashboard ────────────────────────── */}
      <div style={{ padding: 16, borderTop: '1px solid rgba(14,15,12,0.08)' }}>
        <Link to="/dashboard/agents" style={{
          fontSize: 12, color: GRAY, textDecoration: 'none',
          display: 'flex', alignItems: 'center', gap: 4,
          fontFeatureSettings: '"calt"',
        }}>
          ← 返回主面板
        </Link>
      </div>
    </div>
  )
}

function ReqItem({ req, selected, onClick, dimmed }: {
  req: E2edRequirement; selected: boolean; onClick: () => void; dimmed?: boolean
}) {
  const dotColor = STATUS_DOT[req.status] || GRAY
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 12px', borderRadius: 16, cursor: 'pointer',
        marginBottom: 2,
        background: selected ? '#e2f6d5' : 'transparent',
        opacity: dimmed ? 0.6 : 1,
        transition: 'background 0.15s',
        fontFeatureSettings: '"calt"',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'rgba(211,242,192,0.4)' }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent' }}
    >
      <div style={{
        width: 8, height: 8, borderRadius: '50%', background: dotColor,
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: NEAR_BLACK,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontFeatureSettings: '"calt"',
        }}>
          {req.title || req.reqId.slice(0, 8)}
        </div>
        <div style={{
          fontSize: 11, color: GRAY, display: 'flex', gap: 8,
          fontFeatureSettings: '"calt"',
        }}>
          <span>{req.compositeVersion}</span>
          <span>{req.planVersions?.length || 0}P · {req.codeVersions?.length || 0}C</span>
        </div>
      </div>
    </div>
  )
}
