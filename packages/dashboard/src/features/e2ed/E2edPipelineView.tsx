/**
 * E2edPipelineView — Single requirement pipeline status view.
 *
 * Shows: status flow, plan/code versions, issues list, artifacts.
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { e2edApi, type E2edRequirement, type E2edMetrics } from '../../api/e2ed'

const STATUS_FLOW = [
  'CREATED', 'REQ_REVIEWING', 'REQ_REVIEWED',
  'PLANNING', 'PLAN_REVIEWING', 'PLAN_REVIEWED',
  'DELIVERING', 'DELIVERED', 'REVIEWING', 'REVIEWED',
]

const STATUS_COLORS: Record<string, string> = {
  CREATED: '#6b7280', ENV_CHECKING: '#f59e0b', ENV_READY: '#10b981',
  REQ_REVIEWING: '#3b82f6', REQ_REVIEWED: '#10b981',
  PLANNING: '#8b5cf6', PLAN_REVIEWING: '#3b82f6', PLAN_REVIEWED: '#10b981',
  DELIVERING: '#f59e0b', DELIVERED: '#10b981',
  REVIEWING: '#3b82f6', REVIEWED: '#10b981', CLOSED: '#6b7280',
}

export function E2edPipelineView() {
  const { groupId } = useParams<{ groupId: string }>()
  const [req, setReq] = useState<E2edRequirement | null>(null)
  const [metrics, setMetrics] = useState<E2edMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!groupId) return
    Promise.all([
      e2edApi.get(groupId).catch(() => null),
      e2edApi.metrics(groupId).catch(() => null),
    ]).then(([r, m]) => {
      setReq(r)
      setMetrics(m)
      setLoading(false)
    })
  }, [groupId])

  if (loading) return <div style={{ padding: 24, color: '#888' }}>Loading...</div>
  if (!req) return <div style={{ padding: 24, color: 'red' }}>Requirement not found</div>

  const currentIdx = STATUS_FLOW.indexOf(req.status)
  const rid = req.reqId

  const refresh = () => {
    if (!rid) return
    Promise.all([
      e2edApi.get(rid).catch(() => null),
      e2edApi.metrics(rid).catch(() => null),
    ]).then(([r, m]) => { setReq(r); setMetrics(m) })
  }

  const handleAction = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); refresh() }
    catch (e: any) { alert(e.message) }
  }, [rid])

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8 }}>需求 {req.reqId}</h2>
        <span style={{
          background: STATUS_COLORS[req.status] || '#6b7280',
          color: '#fff', padding: '4px 12px', borderRadius: 4, fontSize: 13,
        }}>
          {req.status}
        </span>
        <span style={{ marginLeft: 12, fontFamily: 'monospace', color: '#6b7280' }}>
          {req.compositeVersion}
        </span>
      </div>

      {/* Status Flow */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        marginBottom: 32, flexWrap: 'wrap',
      }}>
        {STATUS_FLOW.map((s, i) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: i <= currentIdx ? (STATUS_COLORS[s] || '#10b981') : '#e5e7eb',
              border: s === req.status ? '2px solid #333' : 'none',
            }} />
            <span style={{
              fontSize: 11,
              color: i <= currentIdx ? '#333' : '#9ca3af',
              fontWeight: s === req.status ? 600 : 400,
            }}>
              {s.replace(/_/g, ' ')}
            </span>
            {i < STATUS_FLOW.length - 1 && (
              <div style={{ width: 16, height: 1, background: '#e5e7eb' }} />
            )}
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div style={{ marginBottom: 24, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(req.status === 'CREATED' || req.status === 'ENV_READY' || req.status === 'REQ_REVIEWED' || req.status === 'PLAN_REVIEWED') && (
          <button onClick={() => handleAction(() => e2edApi.deliver(rid, { planOnly: true }))}
            style={btnStyle('#8b5cf6')}>
            Deliver (Plan Only)
          </button>
        )}
        {(req.status === 'PLAN_REVIEWED' || req.status === 'DELIVERED') && (
          <button onClick={() => handleAction(() => e2edApi.deliver(rid, { codeOnly: true }))}
            style={btnStyle('#f59e0b')}>
            Deliver (Code Only)
          </button>
        )}
        {(req.status === 'DELIVERED' || req.status === 'REVIEWED') && (
          <button onClick={() => handleAction(() => e2edApi.deliver(rid, { codeOnly: true, fix: true }))}
            style={btnStyle('#ef4444')}>
            Fix & Re-deliver
          </button>
        )}
        {(req.status === 'PLANNING' || req.status === 'PLAN_REVIEWED') && (
          <button onClick={() => handleAction(() => e2edApi.review(rid, { type: 'plan' }))}
            style={btnStyle('#3b82f6')}>
            Review Plan
          </button>
        )}
        {(req.status === 'DELIVERED') && (
          <button onClick={() => handleAction(() => e2edApi.review(rid, { type: 'code' }))}
            style={btnStyle('#3b82f6')}>
            Review Code
          </button>
        )}
        {(req.status === 'CREATED' || req.status === 'ENV_READY') && (
          <button onClick={() => handleAction(() => e2edApi.review(rid, { type: 'requirement' }))}
            style={btnStyle('#3b82f6')}>
            Review Requirement
          </button>
        )}
        {(req.status === 'REVIEWED' || req.status === 'DELIVERED' || req.status === 'PLAN_REVIEWED' || req.status === 'REQ_REVIEWED') && (
          <button onClick={() => handleAction(() => e2edApi.close(rid))}
            style={btnStyle('#6b7280')}>
            Close
          </button>
        )}
      </div>

      {/* Two columns: versions | metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        {/* Left: Plan & Code versions */}
        <div>
          <h3 style={{ marginBottom: 12 }}>Plan Versions</h3>
          {req.planVersions?.length === 0 ? (
            <div style={{ color: '#888', fontSize: 13 }}>No plans yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {req.planVersions.map((pv) => (
                <div key={pv.version} style={{
                  padding: 12, border: '1px solid #e5e7eb', borderRadius: 6,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>Plan v{pv.version}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{pv.dirName}</div>
                  </div>
                  <ReviewBadge status={pv.reviewStatus} />
                </div>
              ))}
            </div>
          )}

          <h3 style={{ marginTop: 24, marginBottom: 12 }}>Code Versions</h3>
          {req.codeVersions?.length === 0 ? (
            <div style={{ color: '#888', fontSize: 13 }}>No code yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {req.codeVersions.map((cv) => (
                <div key={cv.version} style={{
                  padding: 12, border: '1px solid #e5e7eb', borderRadius: 6,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>Code v{cv.version}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{cv.dirName}</div>
                  </div>
                  <ReviewBadge status={cv.reviewStatus} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Metrics */}
        <div>
          <h3 style={{ marginBottom: 12 }}>Metrics</h3>
          {metrics ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{
                padding: 16, background: '#f9fafb', borderRadius: 6, textAlign: 'center',
              }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>
                  {(metrics.totalDuration / 1000).toFixed(1)}s
                </div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Total Duration</div>
              </div>

              {metrics.planRounds.map((r) => (
                <div key={`p${r.version}`} style={{
                  padding: 12, border: '1px solid #e5e7eb', borderRadius: 6,
                }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>Plan v{r.version}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    Delivery: {(r.deliveryDuration / 1000).toFixed(1)}s · Review: {(r.reviewDuration / 1000).toFixed(1)}s
                  </div>
                  <ReviewBadge status={r.result} />
                </div>
              ))}

              {metrics.codeRounds.map((r) => (
                <div key={`c${r.version}`} style={{
                  padding: 12, border: '1px solid #e5e7eb', borderRadius: 6,
                }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>Code v{r.version}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    Delivery: {(r.deliveryDuration / 1000).toFixed(1)}s · Review: {(r.reviewDuration / 1000).toFixed(1)}s
                  </div>
                  <ReviewBadge status={r.result} />
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: '#888', fontSize: 13 }}>No metrics available</div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReviewBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span style={{ fontSize: 12, color: '#9ca3af' }}>pending</span>
  const colors: Record<string, string> = { pass: '#10b981', fail: '#ef4444', 'needs-review': '#f59e0b' }
  return (
    <span style={{
      fontSize: 11, fontWeight: 600,
      color: colors[status] || '#6b7280',
      textTransform: 'uppercase',
    }}>
      {status}
    </span>
  )
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: '6px 16px',
    border: 'none',
    borderRadius: 6,
    background: bg,
    color: '#fff',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  }
}
