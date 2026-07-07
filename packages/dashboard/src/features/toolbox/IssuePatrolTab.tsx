/**
 * Issue 巡检 Tab —— 工具箱里展示巡检群状态 + 开关/节流参数 + runs/logs。
 *
 * 巡检群由用户在创建群时选 type=patrol 创建(限 1 个),建群后自动建一条
 * handler_key='issue-patrol' 的定时任务。本 tab 只读写这条 task 的
 * enabled/interval_sec/handler_payload,以及展示巡检 runs/logs。
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { issuesPatrolApi, type PatrolLog, type PatrolRun, type PatrolState } from '../../api/issues-patrol'
import styles from './ManagementTab.module.css'

const VERDICT_LABEL: Record<PatrolLog['verdict'], string> = {
  ready: '✅ 可认领',
  not_ready: '⛔ 不建议',
  uncertain: '❓ 不确定',
  skipped: '⏭ 跳过',
}

const RUN_STATUS_LABEL: Record<PatrolRun['status'], string> = {
  dispatched: '已派发',
  completed: '已完成',
  skipped_quota: '跳过(配额)',
  skipped_overlap: '跳过(重叠)',
  agent_offline: '跳过(离线)',
  error: '错误',
}

function formatTime(ts: string | number | null | undefined): string {
  if (!ts) return '-'
  const n = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(n)) return String(ts)
  return new Date(n).toLocaleString('zh-CN', { hour12: false })
}

// ── runs/logs 卡片共用样式(对齐 ManagementTab 的 .card 风格)──────────────
const panelCardStyle: CSSProperties = {
  border: '1px solid rgba(0,0,0,0.08)',
  borderRadius: 10,
  padding: '14px 16px',
  background: '#fff',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const panelHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
}

const thStyle: CSSProperties = {
  padding: '6px 8px',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  fontSize: 11,
  color: '#888',
  fontWeight: 700,
}

function Pagination({ page, pageSize, total, onChange }: {
  page: number
  pageSize: number
  total: number
  onChange: (p: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 0
  const canNext = page + 1 < totalPages
  if (total === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', fontSize: 12, color: '#666' }}>
      <Button size="sm" variant="secondary" disabled={!canPrev} onClick={() => canPrev && onChange(page - 1)}>‹ 上一页</Button>
      <span>第 {page + 1} / {totalPages} 页</span>
      <Button size="sm" variant="secondary" disabled={!canNext} onClick={() => canNext && onChange(page + 1)}>下一页 ›</Button>
    </div>
  )
}

export function IssuePatrolTab() {
  const navigate = useNavigate()
  const [state, setState] = useState<PatrolState | null>(null)
  const [runs, setRuns] = useState<PatrolRun[]>([])
  const [runsTotal, setRunsTotal] = useState(0)
  const [runsPage, setRunsPage] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<PatrolLog[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const RUNS_PAGE_SIZE = 20

  // 编辑中的节流参数(独立保存按钮)
  const [throughputCap, setThroughputCap] = useState(3)
  const [candidateCap, setCandidateCap] = useState(3)
  const [scanBatch, setScanBatch] = useState(10)
  const [intervalSec, setIntervalSec] = useState(7200)

  const loadState = useCallback(async () => {
    try {
      const s = await issuesPatrolApi.state()
      setState(s)
      if (s.throughputCap) setThroughputCap(s.throughputCap)
      if (s.candidateCap) setCandidateCap(s.candidateCap)
      if (s.scanBatch) setScanBatch(s.scanBatch)
      if (s.intervalSec) setIntervalSec(s.intervalSec)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadRuns = useCallback(async (page: number) => {
    setError(null)
    try {
      const rs = await issuesPatrolApi.listRuns({ limit: RUNS_PAGE_SIZE, offset: page * RUNS_PAGE_SIZE })
      setRuns(rs.runs)
      setRunsTotal(rs.total)
      setRunsPage(page)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadState(), loadRuns(0)]).finally(() => setLoading(false))
  }, [loadState, loadRuns])

  // 首次拿到 runs 时默认选中最新一轮;之后翻页/切 run 不改选中
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) setSelectedRunId(runs[0].run_id)
  }, [runs, selectedRunId])

  useEffect(() => {
    if (!selectedRunId) {
      setLogs([])
      return
    }
    issuesPatrolApi.listRunLogs(selectedRunId).then(setLogs).catch((e) => {
      setError(e instanceof Error ? e.message : String(e))
      setLogs([])
    })
  }, [selectedRunId])

  const handleToggle = async () => {
    if (!state?.taskId) return
    setBusy(true)
    try {
      const next = !state.enabled
      await issuesPatrolApi.updateConfig({ enabled: next })
      await loadState()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleTrigger = async () => {
    if (!state?.taskId) return
    setBusy(true)
    try {
      await issuesPatrolApi.trigger(state.taskId)
      await Promise.all([loadState(), loadRuns(0)])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveConfig = async () => {
    setBusy(true)
    try {
      await issuesPatrolApi.updateConfig({ throughputCap, candidateCap, scanBatch, intervalSec })
      await loadState()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading && !state) {
    return <div className={styles.container}>加载中...</div>
  }

  if (!state?.hasPatrolGroup) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.heading}>Issue 巡检</h2>
            <p className={styles.subheading}>
              还未创建巡检群。去「群」页面创建一个 type=巡检群 的群,选 1 个 agent 作为巡检员,建群后会自动创建每小时巡检任务。
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>Issue 巡检</h2>
          <p className={styles.subheading}>
            巡检群「{state.patrolGroupName}」· 巡检员 {state.patrolAgentName || '(未设置)'}
            {state.lastRunAt ? ` · 上次 ${formatTime(state.lastRunAt)}` : ''}
            {state.lastStatus ? ` · ${state.lastStatus}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant={state.enabled ? 'danger' : 'primary'}
            size="md"
            onClick={handleToggle}
            disabled={busy || !state.taskId}
          >
            {state.enabled ? '关闭巡检' : '开启巡检'}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={handleTrigger}
            disabled={busy || !state.taskId || !state.enabled}
          >
            立即巡检
          </Button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(255,80,80,0.08)', color: '#c33', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {state.lastError && (
        <div style={{ padding: 10, background: 'rgba(255,180,0,0.08)', color: '#a80', borderRadius: 8, fontSize: 12 }}>
          上次错误: {state.lastError}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ padding: 16, background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700 }}>调度</h3>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>状态: <strong>{state.enabled ? '已启用' : '已关闭'}</strong></div>
            <div>间隔(秒): <strong>{state.intervalSec ?? '-'}</strong></div>
            <div>下次巡检: {formatTime(state.nextRunAt)}</div>
          </div>
        </div>
        <div style={{ padding: 16, background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700 }}>节流参数</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center', fontSize: 13 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              吞吐上限 <Input type="number" min={1} max={20} size="sm" value={throughputCap}
                onChange={(e) => setThroughputCap(Number(e.target.value) || 3)}
                style={{ width: 60 }} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              候选上限 <Input type="number" min={1} max={20} size="sm" value={candidateCap}
                onChange={(e) => setCandidateCap(Number(e.target.value) || 3)}
                style={{ width: 60 }} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              扫描批大小 <Input type="number" min={1} max={50} size="sm" value={scanBatch}
                onChange={(e) => setScanBatch(Number(e.target.value) || 10)}
                style={{ width: 60 }} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              间隔(秒) <Input type="number" min={60} size="sm" value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 7200)}
                style={{ width: 80 }} />
            </label>
            <Button variant="secondary" size="sm" onClick={handleSaveConfig} disabled={busy}>保存参数</Button>
          </div>
        </div>
      </div>

      {/* runs + logs:竖向堆叠,runs 在上、logs 在下,各自包成卡片 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* runs 卡片 */}
        <div style={panelCardStyle}>
          <div style={panelHeaderStyle}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>最近巡检</h3>
            <span style={{ fontSize: 11, color: '#888' }}>共 {runsTotal} 条</span>
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 380, overflowY: 'auto', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(0,0,0,0.1)' }}>
                  {['开始时间', '状态', 'in_progress', '扫描', '可认领', '备注'].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#888' }}>还没有巡检记录</td></tr>
                )}
                {runs.map((r) => (
                  <tr
                    key={r.run_id}
                    onClick={() => setSelectedRunId(r.run_id)}
                    style={{
                      cursor: 'pointer',
                      background: r.run_id === selectedRunId ? 'rgba(99,102,241,0.08)' : 'transparent',
                      borderBottom: '1px solid rgba(0,0,0,0.05)',
                    }}
                  >
                    <td style={{ padding: '6px 8px', whiteSpace: 'pre-line', fontSize: 12 }}>
                      {formatTime(r.started_at).replace(' ', '\n')}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{RUN_STATUS_LABEL[r.status]}</td>
                    <td style={{ padding: '6px 8px' }}>{r.in_progress_count}</td>
                    <td style={{ padding: '6px 8px' }}>{r.candidates_scanned}</td>
                    <td style={{ padding: '6px 8px' }}>{r.candidates_ready}</td>
                    <td style={{ padding: '6px 8px', color: '#888', fontSize: 12 }}>{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={runsPage}
            pageSize={RUNS_PAGE_SIZE}
            total={runsTotal}
            onChange={loadRuns}
          />
        </div>

        {/* logs 卡片 */}
        <div style={panelCardStyle}>
          <div style={panelHeaderStyle}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
              日志{selectedRunId ? ` · run ${selectedRunId.slice(0, 8)}` : ''}
            </h3>
            <span style={{ fontSize: 11, color: '#888' }}>{logs.length} 条</span>
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 400, overflowY: 'auto', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(0,0,0,0.1)' }}>
                  {['时间', 'verdict', 'issue', '命中规则', '理由'].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 16, textAlign: 'center', color: '#888' }}>
                    {selectedRunId ? '该轮无日志' : '请选择上方某次巡检'}
                  </td></tr>
                )}
                {logs.map((l) => {
                  const issueId = l.issue_id
                  return (
                  <tr key={l.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{formatTime(l.created_at)}</td>
                    <td style={{ padding: '6px 8px' }}>{VERDICT_LABEL[l.verdict]}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>
                      {issueId ? (
                        <a
                          style={{ color: '#4f46e5', cursor: 'pointer', textDecoration: 'underline' }}
                          title="在看板中打开该 Issue"
                          onClick={(e) => {
                            e.preventDefault()
                            navigate(`/dashboard/kanban?issue=${encodeURIComponent(issueId)}`)
                          }}
                          href={`/dashboard/kanban?issue=${encodeURIComponent(issueId)}`}
                        >
                          {issueId.slice(0, 8)}
                        </a>
                      ) : '-'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{l.rule_matched ?? '-'}</td>
                    <td style={{ padding: '6px 8px', color: '#666', maxWidth: 400 }}>{l.rationale ?? '-'}</td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
