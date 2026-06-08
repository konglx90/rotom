import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { e2edApi, type E2edRequirement, type E2edMetrics } from '../../api/e2ed'
import { useSocket } from '../../context/SocketContext'
import { E2edIssueDrawer } from './E2edIssueDrawer'
import s from './E2ed.module.css'

const FETCH_DEBOUNCE_MS = 2000

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

const STATUS_BADGE: Record<string, string> = {
  CREATED: 'pillGray',
  ENV_READY: 'pillGreen',
  REQ_REVIEWED: 'pillGreen',
  PLANNING: 'pillPurple',
  PLAN_REVIEWED: 'pillGreen',
  DELIVERING: 'pillAmber',
  DELIVERED: 'pillGreen',
  REVIEWED: 'pillGreen',
  CLOSED: 'pillGray',
}

const FLOW_COLORS: Record<string, string> = {
  CREATED: '#868685', ENV_READY: '#054d28',
  REQ_REVIEWED: '#054d28', PLANNING: '#7c3aed',
  PLAN_REVIEWED: '#054d28', DELIVERING: '#d97706',
  DELIVERED: '#054d28', REVIEWED: '#054d28',
}

const ACCENT_MAP = {
  green: 'actionCardGreen',
  purple: 'actionCardPurple',
  amber: 'actionCardAmber',
  red: 'actionCardRed',
} as const

const ACCENT_TITLE_COLOR: Record<string, string> = {
  green: '#054d28', purple: '#7c3aed', amber: '#92400e', red: '#d03238',
}

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

  const { lastIssueChange } = useSocket()

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

  useEffect(() => {
    if (!lastIssueChange || !groupId) return
    const timer = setTimeout(() => fetchData(), FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [lastIssueChange, groupId, fetchData])

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

  if (loading) return <div className={s.centerFill}><span className={s.loadingText}>Loading...</span></div>
  if (!req) return (
    <div className={s.centerCol}>
      <span className={s.loadingText}>未找到该需求</span>
    </div>
  )

  const rid = req.reqId
  const badgeCls = s[STATUS_BADGE[req.status] as keyof typeof s] || s.pillGray
  const currentFlowIdx = STATUS_FLOW.indexOf(req.status)
  const createdAt = req.timeline?.[0]?.at ? new Date(req.timeline[0].at).toLocaleString() : '-'

  return (
    <div className={s.pageWrap}>
      {/* Header */}
      <div className={s.header}>
        <div>
          <h1 className={s.headerTitle}>{req.title || rid}</h1>
          <div className={s.headerSub}>{rid.slice(0, 8)}... · {createdAt}</div>
        </div>
        <div className={s.headerActions}>
          <button onClick={() => setShowGuide(true)} title="使用指南" className={s.iconBtn}>?</button>
          {confirmDelete ? (
            <div className={s.deleteConfirm}>
              <span className={s.deleteConfirmText}>确认删除？</span>
              <button onClick={handleDelete} disabled={deleting} className={`${s.pill} ${s.pillRed}`}
                style={{ cursor: deleting ? 'wait' : 'pointer' }}>{deleting ? '删除中...' : '确认'}</button>
              <button onClick={() => setConfirmDelete(false)} disabled={deleting} className={s.outlinePill}>取消</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} title="删除需求" className={s.iconBtn}>×</button>
          )}
          <span className={`${s.pill} ${s.pillPurple}`}>{req.compositeVersion}</span>
          <span className={`${s.pill} ${badgeCls}`}>{STATUS_LABELS[req.status] || req.status}</span>
        </div>
      </div>

      {/* Status Flow */}
      <div className={`${s.card} ${s.cardTopBlack}`}>
        <div className={s.cardTitle}>状态流程</div>
        <div className={s.flowWrap}>
          {STATUS_FLOW.map((st, i) => {
            const isActive = st === req.status
            const isPassed = i < currentFlowIdx || req.status === 'CLOSED'
            const c = FLOW_COLORS[st] || '#868685'
            return (
              <div key={st} style={{ display: 'flex', alignItems: 'center' }}>
                <div className={s.flowNode}>
                  <div className={`${s.flowDot} ${isActive ? s.flowDotActive : isPassed ? s.flowDotPassed : s.flowDotDefault}`}
                    style={isActive || isPassed ? { background: c, borderColor: c, boxShadow: isActive ? `0 0 0 3px ${c}33` : undefined } : undefined} />
                  <span className={isActive ? s.flowLabelActive : isPassed ? s.flowLabelPassed : s.flowLabel}
                    style={{ color: isActive ? c : undefined }}>{STATUS_LABELS[st]}</span>
                </div>
                {i < STATUS_FLOW.length - 1 && (
                  <div className={`${s.flowLine} ${isPassed ? s.flowLinePassed : s.flowLineDefault}`} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Available Actions */}
      <AvailableActions status={req.status} groupId={rid} hasWorkingDir={!!req.workingDir} />

      {/* Issues */}
      {issues.length > 0 && (
        <div className={`${s.card} ${s.cardTopOrange}`}>
          <div className={s.cardTitle}>
            关联任务
            <span className={s.cardTitleMeta}>{issues.length} 个</span>
          </div>
          {issues.map((issue) => {
            const isOpen = issue.status === 'open'
            const isInProgress = issue.status === 'in_progress'
            const isDone = issue.status === 'done' || issue.status === 'completed'
            const typeLabel: Record<string, string> = { delivery: '交付', review: '评审', collaboration: '协作' }
            const statusCls = isOpen ? s.pillPurple
              : isInProgress ? s.pillAmber
              : isDone ? s.pillGreen
              : s.pillGray
            const statusLabel = isOpen ? '待处理' : isInProgress ? '执行中' : isDone ? '已完成' : issue.status
            return (
              <div key={issue.id} className={s.issueRow} onClick={() => setSelectedIssueId(issue.id)}>
                <span className={`${s.pill} ${statusCls}`}>{statusLabel}</span>
                {issue.type && <span className={`${s.pill} ${s.pillPurple}`}>{typeLabel[issue.type] || issue.type}</span>}
                <span className={s.issueTitle}>{issue.title}</span>
                <span className={s.issueMeta}>{issue.assigned_to || '-'}</span>
                <span className={s.issueMeta}>{new Date(issue.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Status Timeline */}
      {req.timeline && req.timeline.length > 0 && (
        <div className={`${s.card} ${s.cardTopBlue}`}>
          <div className={s.cardTitle}>状态变化</div>
          <div className={s.timelineWrap}>
            <div className={s.timelineLine} />
            {req.timeline.map((evt, i) => {
              const isLast = i === req.timeline.length - 1
              const badgeCls2 = s[STATUS_BADGE[evt.status] as keyof typeof s] || s.pillGray
              const time = new Date(evt.at)
              const label = STATUS_LABELS[evt.status] || evt.status
              let duration = ''
              if (i > 0) {
                const prev = new Date(req.timeline[i - 1].at)
                const diff = time.getTime() - prev.getTime()
                if (diff < 1000) duration = `${diff}ms`
                else if (diff < 60000) duration = `${(diff / 1000).toFixed(1)}s`
                else if (diff < 3600000) duration = `${Math.floor(diff / 60000)}m ${Math.round((diff % 60000) / 1000)}s`
                else duration = `${Math.floor(diff / 3600000)}h ${Math.round((diff % 3600000) / 60000)}m`
              }
              const sb = STATUS_BADGE[evt.status] ? { bg: evt.status === 'CLOSED' ? '#f3f4f6' : '#e2f6d5', color: evt.status === 'CLOSED' ? '#9ca3af' : '#054d28' } : { bg: '#f1f5f9', color: '#64748b' }
              return (
                <div key={i} className={s.timelineRow}>
                  <div className={`${s.timelineDot} ${isLast ? s.timelineDotActive : s.timelineDotDefault}`}
                    style={isLast ? { background: sb.color, border: `2px solid ${sb.color}`, boxShadow: `0 0 0 3px ${sb.color}22` } : undefined} />
                  <span className={s.timelineTime}>
                    {time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  {isLast ? (
                    <span className={`${s.pill} ${s[badgeCls2 as keyof typeof s]}`}>{label}</span>
                  ) : (
                    <span className={s.timelineLabel}>{label}</span>
                  )}
                  {duration && <span className={s.timelineDuration}>+{duration}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Versions */}
      {(req.planVersions?.length > 0 || req.codeVersions?.length > 0) && (
        <div className={`${s.card} ${s.cardTopPurple}`}>
          <div className={s.cardTitle}>
            版本历史
            <span className={s.cardTitleMeta}>{req.planVersions?.length || 0} 方案 · {req.codeVersions?.length || 0} 代码</span>
          </div>
          {req.planVersions.map((pv) => (
            <div key={`p${pv.version}`} className={`${s.versionRow} ${s.versionRowPurple}`}>
              <span className={`${s.pill} ${s.pillPurple}`}>Plan v{pv.version}</span>
              <span className={s.versionTime}>{new Date(pv.createdAt).toLocaleString()}</span>
              <ReviewBadge status={pv.reviewStatus} />
            </div>
          ))}
          {req.codeVersions.map((cv) => (
            <div key={`c${cv.version}`} className={`${s.versionRow} ${s.versionRowGreen}`}>
              <span className={`${s.pill} ${s.pillGreen}`}>Code v{cv.version}</span>
              <span className={s.versionTime}>{new Date(cv.createdAt).toLocaleString()}</span>
              <ReviewBadge status={cv.reviewStatus} />
            </div>
          ))}
        </div>
      )}

      {/* Metrics */}
      {metrics && (
        <div className={`${s.card} ${s.cardTopAmber}`}>
          <div className={s.cardTitle}>度量指标</div>
          <div className={s.metricsGrid}>
            <MetricBox label="总耗时" value={`${(metrics.totalDuration / 1000).toFixed(1)}s`} />
            <MetricBox label="方案轮次" value={`${metrics.planRounds.length}`} />
            <MetricBox label="代码轮次" value={`${metrics.codeRounds.length}`} />
          </div>
          {metrics.planRounds.map((r) => (
            <div key={`mp${r.version}`} className={s.metricRow}>
              <span className={`${s.pill} ${s.pillPurple}`}>Plan v{r.version}</span>
              <span className={s.metricRowLabel}>交付 {(r.deliveryDuration / 1000).toFixed(1)}s</span>
              <span className={s.metricRowLabel}>评审 {(r.reviewDuration / 1000).toFixed(1)}s</span>
              <ReviewBadge status={r.result} />
            </div>
          ))}
          {metrics.codeRounds.map((r) => (
            <div key={`mc${r.version}`} className={s.metricRow}>
              <span className={`${s.pill} ${s.pillGreen}`}>Code v{r.version}</span>
              <span className={s.metricRowLabel}>交付 {(r.deliveryDuration / 1000).toFixed(1)}s</span>
              <span className={s.metricRowLabel}>评审 {(r.reviewDuration / 1000).toFixed(1)}s</span>
              <ReviewBadge status={r.result} />
            </div>
          ))}
        </div>
      )}

      {/* Context Info */}
      {(req.source || req.workingDir || (req.links && req.links.length > 0)) && (
        <div className={`${s.card} ${s.cardTopGray}`}>
          <div className={s.cardTitle}>上下文信息</div>
          <div className={s.contextWrap}>
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

      {/* Requirement Content */}
      {reqText && (
        <div className={`${s.card} ${s.cardTopGray}`}>
          <div className={s.cardTitle}>需求内容</div>
          <div className={s.reqContent}>{reqText}</div>
        </div>
      )}

      <E2edGuideDrawer open={showGuide} onClose={() => setShowGuide(false)} />

      {selectedIssueId && (
        <E2edIssueDrawer issueId={selectedIssueId} groupId={rid} onClose={() => setSelectedIssueId(null)} />
      )}
    </div>
  )
}

function ReviewBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className={s.timelineLabel}>待评审</span>
  const m: Record<string, { cls: string; label: string }> = {
    pass: { cls: 'pillGreen', label: '通过' },
    fail: { cls: 'pillRed', label: '不通过' },
    'needs-review': { cls: 'pillAmber', label: '需确认' },
  }
  const entry = m[status]
  if (entry) return <span className={`${s.pill} ${s[entry.cls as keyof typeof s]}`}>{entry.label}</span>
  return <span className={`${s.pill} ${s.pillGray}`}>{status}</span>
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.metricBox}>
      <div className={s.metricValue}>{value}</div>
      <div className={s.metricLabel}>{label}</div>
    </div>
  )
}

function ContextRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <div className={s.contextRow}>
      <span className={s.contextLabel}>{label}</span>
      <code className={s.contextValue}>{value}</code>
      {copyable && (
        <button onClick={handleCopy} className={`${s.copyBtn} ${copied ? s.copyBtnCopied : ''}`}>
          {copied ? '已复制' : '复制'}
        </button>
      )}
    </div>
  )
}

// ── Available Actions ─────────────────────────────────────────────

interface ActionDef {
  label: string
  desc: string
  cmd: string
  accent: 'green' | 'purple' | 'amber' | 'red'
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
        <div className={`${s.card} ${s.cardTopGray}`}>
          <div className={s.cardTitle}>可用操作</div>
          <div className={s.actionWaiting}>{hint}，暂时没有可执行的操作。</div>
        </div>
      )
    }
    return null
  }

  return (
    <div className={`${s.card} ${s.cardTopGreen}`}>
      <div className={s.cardTitle}>可用操作</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {actions.map((a) => {
          const cardCls = s[ACCENT_MAP[a.accent] as keyof typeof s]
          return (
            <div key={a.label} className={`${s.actionCard} ${cardCls}`}>
              <div className={s.actionHeader}>
                <span className={s.actionTitle} style={{ color: ACCENT_TITLE_COLOR[a.accent] }}>{a.label}</span>
              </div>
              <div className={s.actionDesc}>{a.desc}</div>
              <div className={s.actionCmd}>
                <code className={s.actionCmdCode}>{a.cmd}</code>
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
    <button onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}
      className={`${s.copyBtn} ${copied ? s.copyBtnCopied : ''}`}
      style={{ transition: 'all 0.15s' }}>
      {copied ? '已复制' : '复制'}
    </button>
  )
}

// ── Guide Drawer ──────────────────────────────────────────────────

function E2edGuideDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [content, setContent] = useState('')

  useEffect(() => {
    if (open && !content) e2edApi.guide().then(setContent)
  }, [open])

  if (!open) return null

  return (
    <>
      <div className={s.drawerOverlay} onClick={onClose} />
      <div className={`${s.drawer} ${s.drawerNarrow}`}>
        <div className={s.drawerHeader}>
          <h2 className={s.drawerTitle}>E2ED 使用指南</h2>
          <button onClick={onClose} className={s.iconBtnSmall}>&times;</button>
        </div>
        <div className={s.drawerBody}>
          {content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown> : <span className={s.loadingText}>Loading...</span>}
        </div>
      </div>
    </>
  )
}
