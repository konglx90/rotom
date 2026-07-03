/**
 * Link 智能分类 Tab —— 工具箱里展示采集统计 + 链接列表 + 巡检 runs/logs。
 *
 * 布局(自上而下):
 *   1. header:patrol-link 群名 + 巡检员 + 启用/触发按钮
 *   2. 统计卡片(总链接 / 未分类 / 出现总数 / 已分类 host)
 *   3. 调度 + 节流参数(2 列)
 *   4. 链接列表:filter(category/tag/search/host)+ 表格(category/tags/title 可点行 PATCH override)
 *   5. 巡检 runs + 选中 run 的 logs(双列表格)
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { linksPatrolApi, type LinkItem, type LinkPatrolLog, type LinkPatrolRun, type LinkPatrolState, type LinkPatrolStats } from '../../api/links-patrol'
import styles from './ManagementTab.module.css'

const CATEGORIES = [
  'reference', 'code', 'tool', 'article', 'paper', 'discussion', 'issue-tracker', 'media', 'other',
] as const

const RUN_STATUS_LABEL: Record<LinkPatrolRun['status'], string> = {
  dispatched: '已派发',
  completed: '已完成',
  skipped: '跳过',
  agent_offline: '跳过(离线)',
  error: '错误',
}

function formatTime(ts: string | number | null | undefined): string {
  if (!ts) return '-'
  const n = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(n)) return String(ts)
  return new Date(n).toLocaleString('zh-CN', { hour12: false })
}

export function LinkPatrolTab() {
  const [state, setState] = useState<LinkPatrolState | null>(null)
  const [stats, setStats] = useState<LinkPatrolStats | null>(null)
  const [runs, setRuns] = useState<LinkPatrolRun[]>([])
  const [links, setLinks] = useState<LinkItem[]>([])
  const [linksTotal, setLinksTotal] = useState(0)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LinkPatrolLog[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 节流参数
  const [scanBatch, setScanBatch] = useState(20)
  const [intervalSec, setIntervalSec] = useState(3600)

  // links 过滤
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [filterTag, setFilterTag] = useState<string>('')
  const [filterSearch, setFilterSearch] = useState<string>('')
  const [filterHost, setFilterHost] = useState<string>('')

  // 编辑中的 link
  const [editingLink, setEditingLink] = useState<LinkItem | null>(null)
  const [editCategory, setEditCategory] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editTagsText, setEditTagsText] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, st, rs] = await Promise.all([
        linksPatrolApi.state(),
        linksPatrolApi.stats(),
        linksPatrolApi.listRuns(50),
      ])
      setState(s)
      setStats(st)
      setRuns(rs)
      if (s.scanBatch) setScanBatch(s.scanBatch)
      if (s.intervalSec) setIntervalSec(s.intervalSec)
      if (!selectedRunId && rs.length > 0) {
        setSelectedRunId(rs[0].run_id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [selectedRunId])

  const reloadLinks = useCallback(async () => {
    try {
      const r = await linksPatrolApi.listLinks({
        category: filterCategory || undefined,
        tag: filterTag || undefined,
        search: filterSearch || undefined,
        host: filterHost || undefined,
        limit: 100,
      })
      setLinks(r.items)
      setLinksTotal(r.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [filterCategory, filterTag, filterSearch, filterHost])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    reloadLinks()
  }, [reloadLinks])

  useEffect(() => {
    if (!selectedRunId) {
      setLogs([])
      return
    }
    linksPatrolApi.listRunLogs(selectedRunId).then(setLogs).catch((e) => {
      setError(e instanceof Error ? e.message : String(e))
      setLogs([])
    })
  }, [selectedRunId])

  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(null), 4000)
    return () => clearTimeout(t)
  }, [success])

  const handleToggle = async () => {
    if (!state?.taskId) return
    setBusy(true)
    try {
      const next = !state.enabled
      await linksPatrolApi.updateConfig({ enabled: next })
      await reload()
      setSuccess(next ? '已开启分类' : '已关闭分类')
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
      await linksPatrolApi.trigger(state.taskId)
      await reload()
      setSuccess('已触发立即巡检,稍后刷新查看结果')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveConfig = async () => {
    setBusy(true)
    try {
      await linksPatrolApi.updateConfig({ scanBatch, intervalSec })
      await reload()
      setSuccess('参数已保存')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (link: LinkItem) => {
    setEditingLink(link)
    setEditCategory(link.category ?? '')
    setEditTitle(link.title ?? '')
    // 拉 tags via detail 接口
    linksPatrolApi.getLink(link.id).then((d) => {
      setEditTagsText(d.tags.join(', '))
    }).catch(() => {
      setEditTagsText('')
    })
  }

  const handleSaveEdit = async () => {
    if (!editingLink) return
    setBusy(true)
    try {
      const tags = editTagsText
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
      await linksPatrolApi.updateLink(editingLink.id, {
        category: editCategory || undefined,
        title: editTitle || undefined,
        tags,
      })
      setEditingLink(null)
      await reloadLinks()
      setSuccess('链接已更新,host 规则已写入 memory')
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
            <h2 className={styles.heading}>Link 智能分类</h2>
            <p className={styles.subheading}>
              还未创建链接归纳群。去「群」页面创建一个 type=巡检群 的群并选 1 个 agent 作为巡检员,建群后会自动创建每小时分类任务。
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
          <h2 className={styles.heading}>🔗 Link 智能分类</h2>
          <p className={styles.subheading}>
            群「{state.patrolGroupName}」· 巡检员 {state.patrolAgentName || '(未设置)'}
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
            {state.enabled ? '关闭分类' : '开启分类'}
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

      {success && (
        <div style={{ padding: 12, background: 'rgba(34,197,94,0.08)', color: '#0a7a32', borderRadius: 8, fontSize: 13 }}>
          ✓ {success}
        </div>
      )}

      {state.lastError && (
        <div style={{ padding: 10, background: 'rgba(255,180,0,0.08)', color: '#a80', borderRadius: 8, fontSize: 12 }}>
          上次错误: {state.lastError}
        </div>
      )}

      {/* 统计卡片 */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <StatCard label="总链接" value={stats.totalLinks} hint="links.url_norm UNIQUE" />
          <StatCard label="未分类" value={stats.unclassified} hint="待巡检处理" highlight={stats.unclassified > 0} />
          <StatCard label="出现次数" value={stats.totalOccurrences} hint="含 dedup 后累加" />
          <StatCard label="已分类 host" value={stats.classifiedHosts} hint="unique host" />
        </div>
      )}

      {/* 调度 + 参数 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ padding: 16, background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700 }}>调度</h3>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <div>状态: <strong>{state.enabled ? '已启用' : '已关闭'}</strong></div>
            <div>间隔(秒): <strong>{state.intervalSec ?? '-'}</strong></div>
            <div>下次巡检: {formatTime(state.nextRunAt)}</div>
            {stats?.lastRun && (
              <>
                <div>上次跑: {formatTime(stats.lastRun.started_at)}</div>
                <div>上次状态: {stats.lastRun.status} · 扫描 {stats.lastRun.candidates_scanned} / 分类 {stats.lastRun.candidates_classified}</div>
                {stats.lastRun.note && <div style={{ color: '#888', fontSize: 12 }}>{stats.lastRun.note}</div>}
              </>
            )}
          </div>
        </div>
        <div style={{ padding: 16, background: 'rgba(0,0,0,0.03)', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700 }}>节流参数</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <label>
              每轮扫描上限 scanBatch:{' '}
              <Input type="number" min={1} max={100} size="sm" value={scanBatch}
                onChange={(e) => setScanBatch(Number(e.target.value) || 20)}
                style={{ width: 60 }} />
            </label>
            <label>
              间隔 intervalSec:{' '}
              <Input type="number" min={60} size="sm" value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 3600)}
                style={{ width: 80 }} />
            </label>
            <Button variant="secondary" size="sm" onClick={handleSaveConfig} disabled={busy}>保存参数</Button>
          </div>
        </div>
      </div>

      {/* 链接列表 */}
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px' }}>
          链接列表({linksTotal} 条,展示前 {links.length})
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, fontSize: 12 }}>
          <label>
            分类:
            <Select size="sm" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
              style={{ marginLeft: 4, width: 'auto' }} options={[
                { value: '', label: '全部' },
                ...CATEGORIES.map((c) => ({ value: c, label: c })),
                { value: '__unclassified__', label: '未分类' },
              ]} />
          </label>
          <label>
            tag:
            <Input size="sm" value={filterTag} onChange={(e) => setFilterTag(e.target.value)}
              style={{ marginLeft: 4, width: 80 }} />
          </label>
          <label>
            host:
            <Input size="sm" value={filterHost} onChange={(e) => setFilterHost(e.target.value)}
              style={{ marginLeft: 4, width: 100 }} />
          </label>
          <label>
            搜索:
            <Input size="sm" value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)}
              style={{ marginLeft: 4, width: 120 }} placeholder="url / title" />
          </label>
          <Button size="sm" variant="secondary" onClick={reloadLinks} disabled={busy}>刷新</Button>
        </div>

        {editingLink && (
          <div style={{ padding: 12, background: 'rgba(99,102,241,0.06)', borderRadius: 8, marginBottom: 8, fontSize: 13 }}>
            <div style={{ marginBottom: 8, fontWeight: 700 }}>编辑: {editingLink.url_raw}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <label>
                category:
                <Select size="sm" value={editCategory} onChange={(e) => setEditCategory(e.target.value)}
                  style={{ marginLeft: 4, width: 'auto' }} options={[
                    { value: '', label: '未分类' },
                    ...CATEGORIES.map((c) => ({ value: c, label: c })),
                  ]} />
              </label>
              <label>
                title:
                <Input size="sm" value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                  style={{ marginLeft: 4, width: 220 }} />
              </label>
              <label style={{ flex: 1, minWidth: 220 }}>
                tags(逗号分隔):
                <Input size="sm" value={editTagsText} onChange={(e) => setEditTagsText(e.target.value)}
                  style={{ marginLeft: 4, width: '70%' }} />
              </label>
              <Button size="sm" variant="primary" onClick={handleSaveEdit} disabled={busy}>保存</Button>
              <Button size="sm" variant="secondary" onClick={() => setEditingLink(null)} disabled={busy}>取消</Button>
              <span style={{ color: '#888', fontSize: 11 }}>保存会同时把 host 规则写入 memory(link_classification + manual)</span>
            </div>
          </div>
        )}

        <div style={{ overflowX: 'auto', maxHeight: '50vh', overflowY: 'auto', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(0,0,0,0.1)' }}>
                <th style={{ padding: '6px 8px' }}>host</th>
                <th style={{ padding: '6px 8px' }}>url</th>
                <th style={{ padding: '6px 8px' }}>category</th>
                <th style={{ padding: '6px 8px' }}>tags</th>
                <th style={{ padding: '6px 8px' }}>title</th>
                <th style={{ padding: '6px 8px' }}>last_seen</th>
                <th style={{ padding: '6px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {links.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 16, textAlign: 'center', color: '#888' }}>没有符合条件的链接</td></tr>
              )}
              {links.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => startEdit(l)}
                  style={{
                    cursor: 'pointer',
                    background: l.id === editingLink?.id ? 'rgba(99,102,241,0.08)' : 'transparent',
                    borderBottom: '1px solid rgba(0,0,0,0.05)',
                  }}
                >
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>{l.host}</td>
                  <td style={{ padding: '6px 8px', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <a href={l.url_raw} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                      style={{ color: '#4f46e5', textDecoration: 'underline' }}>
                      {l.url_raw}
                    </a>
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    {l.category
                      ? <span style={{ padding: '1px 6px', background: 'rgba(99,102,241,0.12)', color: '#4f46e5', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{l.category}</span>
                      : <span style={{ color: '#aaa', fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: '6px 8px', color: '#666', fontSize: 11 }}>{l.title ? `📝 ${l.title}` : '—'}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{formatTime(l.last_seen_at).replace(' ', '\n')}</td>
                  <td style={{ padding: '6px 8px', color: '#4f46e5', fontSize: 11 }}>编辑</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* runs + logs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', gap: 16, alignItems: 'start' }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px' }}>最近巡检</h3>
          <div style={{ overflowX: 'auto', maxHeight: '50vh', overflowY: 'auto', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(0,0,0,0.1)' }}>
                  <th style={{ padding: '6px 8px' }}>开始</th>
                  <th style={{ padding: '6px 8px' }}>状态</th>
                  <th style={{ padding: '6px 8px' }}>扫描</th>
                  <th style={{ padding: '6px 8px' }}>分类</th>
                  <th style={{ padding: '6px 8px' }}>备注</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 16, textAlign: 'center', color: '#888' }}>还没有巡检记录</td></tr>
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
                    <td style={{ padding: '6px 8px', whiteSpace: 'pre-line', fontSize: 11 }}>
                      {formatTime(r.started_at).replace(' ', '\n')}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{RUN_STATUS_LABEL[r.status]}</td>
                    <td style={{ padding: '6px 8px' }}>{r.candidates_scanned}</td>
                    <td style={{ padding: '6px 8px' }}>{r.candidates_classified}</td>
                    <td style={{ padding: '6px 8px', color: '#888', fontSize: 11 }}>{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 8px' }}>
            日志 {selectedRunId ? `· 选中 run ${selectedRunId.slice(0, 8)}` : ''}
          </h3>
          <div style={{ overflowX: 'auto', maxHeight: '50vh', overflowY: 'auto', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <tr style={{ textAlign: 'left', borderBottom: '2px solid rgba(0,0,0,0.1)' }}>
                  <th style={{ padding: '6px 8px' }}>时间</th>
                  <th style={{ padding: '6px 8px' }}>category</th>
                  <th style={{ padding: '6px 8px' }}>tags</th>
                  <th style={{ padding: '6px 8px' }}>title</th>
                  <th style={{ padding: '6px 8px' }}>rationale</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 16, textAlign: 'center', color: '#888' }}>
                    {selectedRunId ? '该轮无日志' : '请选择左侧某次巡检'}
                  </td></tr>
                )}
                {logs.map((l) => {
                  let tags: string[] = []
                  if (l.tags) {
                    try {
                      const arr = JSON.parse(l.tags)
                      if (Array.isArray(arr)) tags = arr
                    } catch { /* ignore */ }
                  }
                  return (
                    <tr key={l.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{formatTime(l.created_at)}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{ padding: '1px 6px', background: 'rgba(99,102,241,0.12)', color: '#4f46e5', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{l.category}</span>
                      </td>
                      <td style={{ padding: '6px 8px', color: '#666', fontSize: 11 }}>{tags.join(', ') || '—'}</td>
                      <td style={{ padding: '6px 8px', color: '#666' }}>{l.title ?? '—'}</td>
                      <td style={{ padding: '6px 8px', color: '#666', maxWidth: 360, fontSize: 11 }}>{l.rationale ?? '—'}</td>
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

function StatCard({ label, value, hint, highlight }: { label: string; value: number; hint?: string; highlight?: boolean }) {
  return (
    <div style={{
      padding: '12px 16px',
      background: highlight ? 'rgba(255,180,0,0.08)' : 'rgba(0,0,0,0.03)',
      borderRadius: 8,
      border: highlight ? '1px solid rgba(255,180,0,0.3)' : '1px solid transparent',
    }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{hint}</div>}
    </div>
  )
}
