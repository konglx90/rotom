/**
 * E2edPipelineView — Requirement report page.
 *
 * Wise-inspired design: Lime Green accent, pill buttons, Inter font weight 600.
 */

import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { e2edApi, type E2edRequirement, type E2edMetrics } from '../../api/e2ed'
import { E2edIssueDrawer } from './E2edIssueDrawer'

const GREEN = '#9fe870'
const NEAR_BLACK = '#0e0f0c'
const GRAY = '#868685'
const LIGHT_MINT = '#e2f6d5'

const STATUS_FLOW = [
  'CREATED', 'ENV_READY', 'REQ_REVIEWED',
  'PLANNING', 'PLAN_REVIEWED',
  'DELIVERING', 'DELIVERED', 'REVIEWED',
]

const STATUS_LABELS: Record<string, string> = {
  CREATED: '已创建', ENV_BLOCKED: '环境阻塞',
  ENV_CHECKING: '环境检测中', ENV_READY: '环境就绪',
  REQ_REVIEWING: '需求评审中', REQ_REVIEWED: '需求已评',
  PLANNING: '方案设计中', PLAN_REVIEWING: '方案评审中', PLAN_REVIEWED: '方案已评',
  DELIVERING: '交付中', DELIVERED: '已交付',
  REVIEWING: '评审中', REVIEWED: '已评审',
  CLOSED: '已完成',
}

const STATUS_BADGE: Record<string, { bg: string; color: string }> = {
  CREATED: { bg: '#f1f5f9', color: '#64748b' },
  ENV_READY: { bg: LIGHT_MINT, color: '#054d28' },
  REQ_REVIEWED: { bg: LIGHT_MINT, color: '#054d28' },
  PLANNING: { bg: '#f3e8ff', color: '#7c3aed' },
  PLAN_REVIEWED: { bg: LIGHT_MINT, color: '#054d28' },
  DELIVERING: { bg: '#fef3c7', color: '#92400e' },
  DELIVERED: { bg: LIGHT_MINT, color: '#054d28' },
  REVIEWED: { bg: LIGHT_MINT, color: '#054d28' },
  CLOSED: { bg: '#f3f4f6', color: '#9ca3af' },
}

const FLOW_COLORS: Record<string, string> = {
  CREATED: GRAY, ENV_READY: '#054d28',
  REQ_REVIEWED: '#054d28', PLANNING: '#7c3aed',
  PLAN_REVIEWED: '#054d28', DELIVERING: '#d97706',
  DELIVERED: '#054d28', REVIEWED: '#054d28',
}

const ff = { fontFeatureSettings: '"calt"' } as React.CSSProperties

function pill(bg: string, color: string): React.CSSProperties {
  return { display: 'inline-block', padding: '2px 10px', borderRadius: 9999, fontSize: 12, fontWeight: 600, background: bg, color, ...ff }
}

const card = (accent: string): React.CSSProperties => ({
  background: '#fff', borderRadius: 20, padding: 24, marginBottom: 16,
  boxShadow: `rgba(14,15,12,0.06) 0px 0px 0px 1px`,
  borderTop: `3px solid ${accent}`,
})

export function E2edPipelineView() {
  const { groupId } = useParams<{ groupId: string }>()
  const navigate = useNavigate()
  const [req, setReq] = useState<E2edRequirement | null>(null)
  const [metrics, setMetrics] = useState<E2edMetrics | null>(null)
  const [reqText, setReqText] = useState('')
  const [loading, setLoading] = useState(true)
  const [showGuide, setShowGuide] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [issues, setIssues] = useState<Array<{
    id: string; title: string; status: string; type: string | null;
    created_by: string | null; assigned_to: string | null;
    working_dir: string | null; created_at: string;
  }>>([])
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null)

  const fetchData = useCallback(() => {
    if (!groupId) return
    Promise.all([
      e2edApi.get(groupId).catch(() => null),
      e2edApi.metrics(groupId).catch(() => null),
      e2edApi.text(groupId).then(r => r.text).catch(() => ''),
      e2edApi.issues(groupId).catch(() => []),
    ]).then(([r, m, t, i]) => { setReq(r); setMetrics(m); setReqText(t || ''); setIssues(i || []); setLoading(false) })
  }, [groupId])

  useEffect(() => { fetchData() }, [fetchData])

  const handleDelete = useCallback(() => {
    if (!groupId) return
    setDeleting(true)
    e2edApi.delete(groupId).then(() => {
      navigate('/dashboard/e2ed')
    }).catch(() => {
      setDeleting(false)
      setConfirmDelete(false)
    })
  }, [groupId, navigate])

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: GRAY, ...ff }}>Loading...</div>
  if (!req) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', ...ff }}>
      <div style={{ color: GRAY, marginBottom: 8 }}>未找到该需求</div>
    </div>
  )

  const rid = req.reqId
  const sb = STATUS_BADGE[req.status] || STATUS_BADGE.CREATED
  const currentFlowIdx = STATUS_FLOW.indexOf(req.status)
  const createdAt = req.timeline?.[0]?.at ? new Date(req.timeline[0].at).toLocaleString() : '-'

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 28px 60px', fontFamily: 'Inter, -apple-system, sans-serif', ...ff }}>
      {/* ── Header ──────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 900, color: NEAR_BLACK, letterSpacing: -0.3, marginBottom: 4, lineHeight: 1.1, ...ff }}>
            {req.title || rid}
          </h1>
          <div style={{ fontSize: 12, color: GRAY, ...ff }}>
            {rid.slice(0, 8)}... · {createdAt}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setShowGuide(true)} title="使用指南" style={{
            width: 30, height: 30, borderRadius: '50%', border: '1px solid rgba(14,15,12,0.12)',
            background: 'transparent', color: GRAY, fontSize: 14, fontWeight: 700,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', ...ff,
          }}>?</button>
          {confirmDelete ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#d03238', fontWeight: 600, ...ff }}>确认删除？</span>
              <button onClick={handleDelete} disabled={deleting} style={{
                padding: '2px 10px', borderRadius: 9999, border: 'none',
                background: '#fef2f2', color: '#d03238', fontSize: 12, fontWeight: 600,
                cursor: deleting ? 'wait' : 'pointer', ...ff,
              }}>{deleting ? '删除中...' : '确认'}</button>
              <button onClick={() => setConfirmDelete(false)} disabled={deleting} style={{
                padding: '2px 10px', borderRadius: 9999, border: '1px solid rgba(14,15,12,0.12)',
                background: 'transparent', color: GRAY, fontSize: 12, fontWeight: 600,
                cursor: 'pointer', ...ff,
              }}>取消</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} title="删除需求" style={{
              width: 30, height: 30, borderRadius: '50%', border: '1px solid rgba(14,15,12,0.12)',
              background: 'transparent', color: GRAY, fontSize: 14, fontWeight: 700,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', ...ff,
            }}>×</button>
          )}
          <span style={pill('#f3e8ff', '#7c3aed')}>{req.compositeVersion}</span>
          <span style={pill(sb.bg, sb.color)}>{STATUS_LABELS[req.status] || req.status}</span>
        </div>
      </div>

      {/* ── Status Flow ─────────────────────────────────── */}
      <div style={card('#0e0f0c')}>
        <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 16, ...ff }}>状态流程</div>
        <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', padding: '4px 0' }}>
          {STATUS_FLOW.map((s, i) => {
            const isActive = s === req.status
            const isPassed = i < currentFlowIdx || req.status === 'CLOSED'
            const c = FLOW_COLORS[s] || GRAY
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 56 }}>
                  <div style={{
                    width: isActive ? 14 : 10, height: isActive ? 14 : 10, borderRadius: '50%',
                    background: isActive || isPassed ? c : '#e2e8f0',
                    border: isActive ? `2px solid ${c}` : 'none',
                    boxShadow: isActive ? `0 0 0 3px ${c}33` : 'none',
                  }} />
                  <span style={{ fontSize: 10, marginTop: 4, color: isActive ? c : isPassed ? NEAR_BLACK : GRAY, fontWeight: isActive ? 700 : 400, whiteSpace: 'nowrap', ...ff }}>
                    {STATUS_LABELS[s]}
                  </span>
                </div>
                {i < STATUS_FLOW.length - 1 && (
                  <div style={{ flex: '0 0 20px', height: 2, background: isPassed ? '#054d28' : '#e2e8f0', marginTop: -14 }} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Available Actions ─────────────────────────────── */}
      <AvailableActions status={req.status} groupId={rid} hasWorkingDir={!!req.workingDir} />

      {/* ── Issues ─────────────────────────────────────── */}
      {issues.length > 0 && (
        <div style={card('#ea580c')}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>
            关联任务
            <span style={{ fontSize: 12, color: GRAY, fontWeight: 400, marginLeft: 8, ...ff }}>{issues.length} 个</span>
          </div>
          {issues.map((issue) => {
            const isOpen = issue.status === 'open'
            const isInProgress = issue.status === 'in_progress'
            const isDone = issue.status === 'done' || issue.status === 'completed'
            const typeLabel: Record<string, string> = { delivery: '交付', review: '评审', collaboration: '协作' }
            const statusColors = isOpen
              ? { bg: '#dbeafe', color: '#1d4ed8', label: '待处理' }
              : isInProgress
                ? { bg: '#fef3c7', color: '#92400e', label: '执行中' }
                : isDone
                  ? { bg: LIGHT_MINT, color: '#054d28', label: '已完成' }
                  : { bg: '#f1f5f9', color: '#64748b', label: issue.status }
            return (
              <div key={issue.id} onClick={() => setSelectedIssueId(issue.id)} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', borderRadius: 14, marginBottom: 4,
                background: 'rgba(234,88,12,0.04)', cursor: 'pointer',
              }}>
                <span style={pill(statusColors.bg, statusColors.color)}>{statusColors.label}</span>
                {issue.type && <span style={pill('#f3e8ff', '#7c3aed')}>{typeLabel[issue.type] || issue.type}</span>}
                <span style={{ flex: 1, fontSize: 13, color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...ff }}>
                  {issue.title}
                </span>
                <span style={{ fontSize: 11, color: GRAY, flexShrink: 0, ...ff }}>{issue.assigned_to || '-'}</span>
                <span style={{ fontSize: 11, color: GRAY, flexShrink: 0, ...ff }}>{new Date(issue.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Status Timeline ─────────────────────────────── */}
      {req.timeline && req.timeline.length > 0 && (
        <div style={card('#2563eb')}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>状态变化</div>
          <div style={{ position: 'relative', paddingLeft: 20 }}>
            {/* Vertical line */}
            <div style={{ position: 'absolute', left: 6, top: 6, bottom: 6, width: 2, background: 'rgba(37,99,235,0.15)', borderRadius: 1 }} />
            {req.timeline.map((evt, i) => {
              const isLast = i === req.timeline.length - 1
              const sb = STATUS_BADGE[evt.status] || STATUS_BADGE.CREATED
              const time = new Date(evt.at)
              const label = STATUS_LABELS[evt.status] || evt.status
              // Compute duration since previous event
              let duration = ''
              if (i > 0) {
                const prev = new Date(req.timeline[i - 1].at)
                const diff = time.getTime() - prev.getTime()
                if (diff < 1000) duration = `${diff}ms`
                else if (diff < 60000) duration = `${(diff / 1000).toFixed(1)}s`
                else if (diff < 3600000) duration = `${Math.floor(diff / 60000)}m ${Math.round((diff % 60000) / 1000)}s`
                else duration = `${Math.floor(diff / 3600000)}h ${Math.round((diff % 3600000) / 60000)}m`
              }
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: isLast ? 0 : 10, position: 'relative' }}>
                  {/* Dot on the line */}
                  <div style={{
                    position: 'absolute', left: -17, top: 4,
                    width: isLast ? 10 : 8, height: isLast ? 10 : 8, borderRadius: '50%',
                    background: isLast ? sb.color : '#c7d2fe',
                    border: isLast ? `2px solid ${sb.color}` : 'none',
                    boxShadow: isLast ? `0 0 0 3px ${sb.color}22` : 'none',
                  }} />
                  <span style={{ fontSize: 12, color: GRAY, fontWeight: 400, width: 78, flexShrink: 0, ...ff }}>
                    {time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span style={isLast ? pill(sb.bg, sb.color) : { fontSize: 12, color: '#64748b', ...ff }}>{label}</span>
                  {duration && <span style={{ fontSize: 11, color: '#94a3b8', ...ff }}>+{duration}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Versions ────────────────────────────────────── */}
      {(req.planVersions?.length > 0 || req.codeVersions?.length > 0) && (
        <div style={card('#7c3aed')}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>
            版本历史
            <span style={{ fontSize: 12, color: GRAY, fontWeight: 400, marginLeft: 8, ...ff }}>
              {req.planVersions?.length || 0} 方案 · {req.codeVersions?.length || 0} 代码
            </span>
          </div>
          {req.planVersions.map((pv) => (
            <div key={`p${pv.version}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 16, marginBottom: 4, background: 'rgba(124,58,237,0.04)' }}>
              <span style={pill('#f3e8ff', '#7c3aed')}>Plan v{pv.version}</span>
              <span style={{ fontSize: 12, color: GRAY, ...ff }}>{new Date(pv.createdAt).toLocaleString()}</span>
              <ReviewBadge status={pv.reviewStatus} />
            </div>
          ))}
          {req.codeVersions.map((cv) => (
            <div key={`c${cv.version}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 16, marginBottom: 4, background: 'rgba(5,77,40,0.04)' }}>
              <span style={pill(LIGHT_MINT, '#054d28')}>Code v{cv.version}</span>
              <span style={{ fontSize: 12, color: GRAY, ...ff }}>{new Date(cv.createdAt).toLocaleString()}</span>
              <ReviewBadge status={cv.reviewStatus} />
            </div>
          ))}
        </div>
      )}

      {/* ── Metrics ─────────────────────────────────────── */}
      {metrics && (
        <div style={card('#d97706')}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>度量指标</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
            <MetricBox label="总耗时" value={`${(metrics.totalDuration / 1000).toFixed(1)}s`} />
            <MetricBox label="方案轮次" value={`${metrics.planRounds.length}`} />
            <MetricBox label="代码轮次" value={`${metrics.codeRounds.length}`} />
          </div>
          {metrics.planRounds.map((r) => (
            <div key={`mp${r.version}`} style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, padding: '6px 0', ...ff }}>
              <span style={pill('#f3e8ff', '#7c3aed')}>Plan v{r.version}</span>
              <span style={{ color: GRAY, ...ff }}>交付 {(r.deliveryDuration / 1000).toFixed(1)}s</span>
              <span style={{ color: GRAY, ...ff }}>评审 {(r.reviewDuration / 1000).toFixed(1)}s</span>
              <ReviewBadge status={r.result} />
            </div>
          ))}
          {metrics.codeRounds.map((r) => (
            <div key={`mc${r.version}`} style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 13, padding: '6px 0', ...ff }}>
              <span style={pill(LIGHT_MINT, '#054d28')}>Code v{r.version}</span>
              <span style={{ color: GRAY, ...ff }}>交付 {(r.deliveryDuration / 1000).toFixed(1)}s</span>
              <span style={{ color: GRAY, ...ff }}>评审 {(r.reviewDuration / 1000).toFixed(1)}s</span>
              <ReviewBadge status={r.result} />
            </div>
          ))}
        </div>
      )}

      {/* ── Context Info ────────────────────────────────── */}
      {(req.source || req.workingDir || (req.links && req.links.length > 0)) && (
        <div style={card('#64748b')}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>上下文信息</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {req.source && (
              <ContextRow label="来源" value={req.source === 'cli' ? 'CLI 命令' : req.source === 'api' ? 'Dashboard' : req.source} />
            )}
            {req.workingDir && <ContextRow label="工作目录" value={req.workingDir} copyable />}
            {req.links && req.links.length > 0 && req.links.map((l, i) => (
              <ContextRow key={i} label={l.type === 'git-branch' ? 'Git 分支' : l.type} value={l.branch || l.url} copyable />
            ))}
          </div>
        </div>
      )}

      {/* ── Requirement Content ──────────────────────────── */}
      {reqText && (
        <div style={card(GRAY)}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>需求内容</div>
          <div style={{ fontSize: 14, lineHeight: 1.6, color: '#334155', whiteSpace: 'pre-wrap', ...ff }}>
            {reqText}
          </div>
        </div>
      )}

      {/* ── Guide Drawer ───────────────────────────────── */}
      <E2edGuideDrawer open={showGuide} onClose={() => setShowGuide(false)} />

      {/* ── Issue Detail Drawer ────────────────────────── */}
      {selectedIssueId && (
        <E2edIssueDrawer
          issueId={selectedIssueId}
          groupId={rid}
          onClose={() => setSelectedIssueId(null)}
        />
      )}
    </div>
  )
}

function ReviewBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span style={{ fontSize: 12, color: GRAY, ...ff }}>待评审</span>
  const m: Record<string, { bg: string; color: string; label: string }> = {
    pass: { bg: LIGHT_MINT, color: '#054d28', label: '通过' },
    fail: { bg: '#fef2f2', color: '#d03238', label: '不通过' },
    'needs-review': { bg: '#fef3c7', color: '#92400e', label: '需确认' },
  }
  const s = m[status] || { bg: '#f3f4f6', color: GRAY, label: status }
  return <span style={pill(s.bg, s.color)}>{s.label}</span>
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 16, background: 'rgba(14,15,12,0.03)', borderRadius: 16, textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: NEAR_BLACK, ...ff }}>{value}</div>
      <div style={{ fontSize: 12, color: GRAY, marginTop: 2, ...ff }}>{label}</div>
    </div>
  )
}

function ContextRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderRadius: 12, background: 'rgba(14,15,12,0.02)' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: GRAY, width: 60, flexShrink: 0, ...ff }}>{label}</span>
      <code style={{ flex: 1, fontSize: 13, fontFamily: '"SF Mono", Menlo, monospace', color: '#334155', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...ff }}>{value}</code>
      {copyable && (
        <button onClick={handleCopy} style={{
          padding: '2px 10px', borderRadius: 9999, border: 'none',
          background: copied ? LIGHT_MINT : '#f1f5f9',
          color: copied ? '#054d28' : '#64748b',
          fontSize: 11, fontWeight: 600, cursor: 'pointer', ...ff,
        }}>{copied ? '已复制' : '复制'}</button>
      )}
    </div>
  )
}

// ── Available Actions (state machine) ──────────────────────────────────────

interface ActionDef {
  label: string
  desc: string
  cmd: string
  accent: 'green' | 'purple' | 'amber' | 'red'
}

const ACCENT_MAP = {
  green: { bg: LIGHT_MINT, color: '#054d28', border: 'rgba(5,77,40,0.15)' },
  purple: { bg: '#f3e8ff', color: '#7c3aed', border: 'rgba(124,58,237,0.15)' },
  amber: { bg: '#fef3c7', color: '#92400e', border: 'rgba(146,64,14,0.15)' },
  red: { bg: '#fef2f2', color: '#d03238', border: 'rgba(208,50,56,0.15)' },
}

function getAvailableActions(status: string, groupId: string, hasCwd: boolean): ActionDef[] {
  const cwd = hasCwd ? '' : ' --cwd <项目目录>'
  switch (status) {
    case 'CREATED':
    case 'ENV_READY':
      return [
        { label: '生成方案', desc: '让 Claude 分析需求并生成实现方案', cmd: `rotom e2ed deliver ${groupId} --plan-only${cwd}`, accent: 'green' },
        { label: '需求评审', desc: '让 Codex 独立评审需求质量', cmd: `rotom e2ed review ${groupId} --type requirement${cwd}`, accent: 'purple' },
      ]
    case 'ENV_BLOCKED':
      return [
        { label: '指定目录重试', desc: '环境检查失败，指定正确的项目目录重试', cmd: `rotom e2ed deliver ${groupId} --plan-only --cwd <正确目录>`, accent: 'red' },
      ]
    case 'REQ_REVIEWED':
      return [
        { label: '生成方案', desc: '需求已通过评审，开始生成实现方案', cmd: `rotom e2ed deliver ${groupId} --plan-only${cwd}`, accent: 'green' },
      ]
    case 'PLAN_REVIEWED':
      return [
        { label: '实现代码', desc: '方案已通过评审，让 Claude 编写代码', cmd: `rotom e2ed deliver ${groupId} --code-only${cwd}`, accent: 'green' },
        { label: '再次方案评审', desc: '重新评审当前方案', cmd: `rotom e2ed review ${groupId} --type plan${cwd}`, accent: 'purple' },
      ]
    case 'DELIVERED':
      return [
        { label: '代码评审', desc: '代码已交付，让 Codex 评审代码质量', cmd: `rotom e2ed review ${groupId} --type code${cwd}`, accent: 'green' },
        { label: '修复重交', desc: '基于上轮评审反馈修复并重新提交', cmd: `rotom e2ed deliver ${groupId} --code-only --fix${cwd}`, accent: 'amber' },
        { label: '关闭需求', desc: '跳过评审，直接关闭', cmd: `rotom e2ed close ${groupId}`, accent: 'purple' },
      ]
    case 'REVIEWED':
      return [
        { label: '修复重交', desc: '基于评审反馈修复代码', cmd: `rotom e2ed deliver ${groupId} --code-only --fix${cwd}`, accent: 'green' },
        { label: '关闭需求', desc: '评审已通过，关闭需求', cmd: `rotom e2ed close ${groupId}`, accent: 'purple' },
      ]
    case 'REQ_REVIEWING':
    case 'PLANNING':
    case 'PLAN_REVIEWING':
    case 'DELIVERING':
    case 'REVIEWING':
    case 'ENV_CHECKING':
      return []
    case 'CLOSED':
      return []
    default:
      return []
  }
}

function AvailableActions({ status, groupId, hasWorkingDir }: { status: string; groupId: string; hasWorkingDir: boolean }) {
  const actions = getAvailableActions(status, groupId, hasWorkingDir)
  if (actions.length === 0) {
    const waitingStates: Record<string, string> = {
      ENV_CHECKING: '环境检测中...',
      REQ_REVIEWING: '需求评审中...',
      PLANNING: '方案生成中...',
      PLAN_REVIEWING: '方案评审中...',
      DELIVERING: '代码交付中...',
      REVIEWING: '代码评审中...',
      CLOSED: '此需求已完成',
    }
    const hint = waitingStates[status]
    if (hint) {
      return (
        <div style={card(GRAY)}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 4, ...ff }}>可用操作</div>
          <div style={{ fontSize: 13, color: GRAY, ...ff }}>{hint}，暂时没有可执行的操作。</div>
        </div>
      )
    }
    return null
  }

  return (
    <div style={card(GREEN)}>
      <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 12, ...ff }}>可用操作</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {actions.map((a) => {
          const c = ACCENT_MAP[a.accent]
          return (
            <div key={a.label} style={{
              padding: '12px 16px', borderRadius: 14,
              border: `1px solid ${c.border}`, background: c.bg,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: c.color, ...ff }}>{a.label}</span>
              </div>
              <div style={{ fontSize: 12, color: '#334155', marginBottom: 8, lineHeight: 1.4, ...ff }}>{a.desc}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.6)', borderRadius: 8, padding: '6px 10px' }}>
                <code style={{ flex: 1, fontSize: 12, fontFamily: '"SF Mono", Menlo, monospace', color: '#334155', ...ff }}>{a.cmd}</code>
                <CopyButton text={a.cmd} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })} style={{
      padding: '2px 10px', borderRadius: 9999, border: 'none',
      background: copied ? LIGHT_MINT : 'rgba(14,15,12,0.06)',
      color: copied ? '#054d28' : '#64748b',
      fontSize: 11, fontWeight: 600, cursor: 'pointer', ...ff,
      transition: 'all 0.15s',
    }}>{copied ? '已复制' : '复制'}</button>
  )
}

// ── E2edGuideDrawer ──────────────────────────────────────────────────────────

function E2edGuideDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [content, setContent] = useState('')

  useEffect(() => {
    if (open && !content) e2edApi.guide().then(setContent)
  }, [open])

  if (!open) return null

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(14,15,12,0.3)',
        zIndex: 1000, backdropFilter: 'blur(2px)',
      }} />

      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 560,
        background: '#fff', boxShadow: '-4px 0 24px rgba(14,15,12,0.1)',
        zIndex: 1001, display: 'flex', flexDirection: 'column',
        fontFamily: 'Inter, -apple-system, sans-serif', ...ff,
        overflow: 'hidden',
      }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(14,15,12,0.08)', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: NEAR_BLACK, margin: 0, ...ff }}>E2ED 使用指南</h2>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: '50%', border: 'none',
            background: '#f1f5f9', color: GRAY, fontSize: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>&times;</button>
        </div>

        <div className="e2ed-guide-content" style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 40px' }}>
          {content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown> : <div style={{ color: GRAY, ...ff }}>Loading...</div>}
        </div>
      </div>
    </>
  )
}
