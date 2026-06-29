import { useState, useEffect, useCallback } from 'react'
import { messagesApi } from '../../api/messages'
import { groupsApi } from '../../api/groups'
import type { Message, Group } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import styles from './MessagesView.module.css'

const PAGE_SIZE = 50
const STATUS_OPTIONS = ['', 'routed', 'queued', 'delivered', 'failed', 'no_target', 'ok', 'group_message']
const MENTION_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'mentioned', label: '有提及' },
  { value: 'not_mentioned', label: '无提及' },
] as const

function formatTsParts(ts: string): { date: string; time: string } {
  try {
    const normalized = ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z'
    const d = new Date(normalized)
    return {
      date: d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      time: d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    }
  } catch {
    return { date: ts, time: '' }
  }
}

function safeParse(p: string): unknown {
  try { return JSON.parse(p) } catch { return p }
}

function payloadSummary(p: string): string {
  const parsed = safeParse(p)
  if (typeof parsed === 'string') return parsed
  if (parsed && typeof parsed === 'object') {
    const msg = (parsed as Record<string, unknown>).message
    if (typeof msg === 'string') return msg
    return JSON.stringify(parsed)
  }
  return String(p)
}

function groupMsgHasMention(p: string): boolean | undefined {
  try {
    const parsed = JSON.parse(p)
    if (Array.isArray(parsed.mentions)) return parsed.mentions.length > 0
    if (parsed.message && typeof parsed.message === 'string') return /@[\w一-鿿][\w.一-鿿-]*/.test(parsed.message)
  } catch { /* ignore */ }
  return undefined
}

interface MessageStreamProps {
  /** 锁定群:提供则隐藏群下拉、强制 groupId,弹窗场景用 */
  lockGroupId?: string
  /** 外部传入群列表(可选);不传则内部 groupsApi.list() */
  groups?: Group[]
}

export function MessageStream({ lockGroupId, groups: groupsProp }: MessageStreamProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [internalGroups, setInternalGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const groups = groupsProp ?? internalGroups

  const [filters, setFilters] = useState({
    from: '',
    to: '',
    status: '',
    keyword: '',
    groupId: lockGroupId ?? '',
    mentionFilter: '',
  })

  useEffect(() => {
    if (!groupsProp) {
      groupsApi.list().then(setInternalGroups).catch(() => setInternalGroups([]))
    }
  }, [groupsProp])

  // lockGroupId 变化时同步(弹窗每次 mount 即可,但防御性保留)
  useEffect(() => {
    if (lockGroupId !== undefined) {
      setFilters(prev => prev.groupId === lockGroupId ? prev : { ...prev, groupId: lockGroupId })
    }
  }, [lockGroupId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await messagesApi.list({
        from: filters.from || undefined,
        to: filters.to || undefined,
        status: filters.status || undefined,
        keyword: filters.keyword || undefined,
        groupId: filters.groupId || undefined,
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE,
      })
      setHasMore(res.messages.length > PAGE_SIZE)
      setMessages(res.messages.slice(0, PAGE_SIZE))
      setTotalCount(res.total)
    } catch (error) {
      console.error('Failed to load messages:', error)
      setMessages([])
      setHasMore(false)
      setTotalCount(0)
    } finally {
      setLoading(false)
    }
  }, [filters, page])

  const filteredMessages = filters.mentionFilter === 'all' || !filters.mentionFilter
    ? messages
    : messages.filter(m => {
        const hasMention = groupMsgHasMention(m.payload)
        if (hasMention === undefined) return filters.mentionFilter === 'not_mentioned'
        return filters.mentionFilter === 'mentioned' ? hasMention : !hasMention
      })

  useEffect(() => { load() }, [load])

  const handleFilterChange = (key: keyof typeof filters, value: string) => {
    // 群锁定时不允许改 groupId
    if (key === 'groupId' && lockGroupId !== undefined) return
    setFilters(prev => ({ ...prev, [key]: value }))
    setPage(0)
  }

  const handleReset = () => {
    setFilters({
      from: '',
      to: '',
      status: '',
      keyword: '',
      groupId: lockGroupId ?? '',
      mentionFilter: '',
    })
    setPage(0)
  }

  const groupNameById = (gid: string | null | undefined) => {
    if (!gid) return ''
    const g = groups.find(x => x.id === gid)
    return g?.name || gid.slice(0, 8)
  }

  const selected = messages.find(m => m.id === selectedId)

  return (
    <div className={styles.container}>
      <div className={styles.filters}>
        <div className={styles.filter}>
          <label className={styles.filterLabel}>发送方</label>
          <input
            className={styles.filterInput}
            value={filters.from}
            onChange={e => handleFilterChange('from', e.target.value)}
            placeholder="agent 名"
          />
        </div>
        <div className={styles.filter}>
          <label className={styles.filterLabel}>接收方</label>
          <input
            className={styles.filterInput}
            value={filters.to}
            onChange={e => handleFilterChange('to', e.target.value)}
            placeholder="agent 名"
          />
        </div>
        <div className={styles.filter}>
          <label className={styles.filterLabel}>状态</label>
          <select
            className={styles.filterSelect}
            value={filters.status}
            onChange={e => handleFilterChange('status', e.target.value)}
          >
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s}>{s || '全部'}</option>
            ))}
          </select>
        </div>
        {lockGroupId === undefined && (
          <div className={styles.filter}>
            <label className={styles.filterLabel}>群</label>
            <select
              className={styles.filterSelect}
              value={filters.groupId}
              onChange={e => handleFilterChange('groupId', e.target.value)}
            >
              <option value="">全部</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className={styles.filter}>
          <label className={styles.filterLabel}>提及</label>
          <select
            className={styles.filterSelect}
            value={filters.mentionFilter}
            onChange={e => handleFilterChange('mentionFilter', e.target.value)}
          >
            {MENTION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className={styles.filter}>
          <label className={styles.filterLabel}>关键字</label>
          <input
            className={styles.filterInput}
            value={filters.keyword}
            onChange={e => handleFilterChange('keyword', e.target.value)}
            placeholder="payload 包含"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={handleReset}>重置</Button>
      </div>

      <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th style={{ width: 100 }}>时间</th>
            <th style={{ width: 140 }}>发送方</th>
            <th style={{ width: 140 }}>接收方</th>
            <th style={{ width: 140 }}>群</th>
            <th style={{ width: 60 }}>方向</th>
            <th style={{ width: 60 }}>来源</th>
            <th style={{ width: 100 }}>状态</th>
            <th>内容</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={8} className={styles.empty}>加载中...</td></tr>
          ) : filteredMessages.length === 0 ? (
            <tr><td colSpan={8} className={styles.empty}>没有匹配的消息</td></tr>
          ) : filteredMessages.map(m => {
            const mentions = (() => { try { const p = JSON.parse(m.payload); return Array.isArray(p.mentions) ? p.mentions : [] } catch { return [] } })()
            return (
            <tr
              key={m.id}
              className={`${styles.row} ${selectedId === m.id ? styles.rowSelected : ''}`}
              onClick={() => setSelectedId(selectedId === m.id ? null : m.id)}
            >
              <td className={styles.tsCell}>{(() => {
                const { date, time } = formatTsParts(m.timestamp)
                return (
                  <div className={styles.tsParts}>
                    <span>{date}</span>
                    <span>{time}</span>
                  </div>
                )
              })()}</td>
              <td>{m.from_name || '—'}</td>
              <td>{m.to_name || '—'}</td>
              <td>{m.group_id ? groupNameById(m.group_id) : '—'}</td>
              <td>{m.direction || '—'}</td>
              <td>
                {m.source ? (
                  <Badge tone="source" value={m.source}>
                    {m.source === 'cli' ? 'CLI' : m.source === 'ws' ? 'WS' : m.source === 'api' ? 'API' : m.source}
                  </Badge>
                ) : '—'}
              </td>
              <td>
                {m.status && (
                  <Badge tone="status" value={m.status}>
                    {m.status.replace('_', ' ')}
                  </Badge>
                )}
                {mentions.length > 0 && (
                  <span className={`${styles.mentionChip} ${styles.mentionHas}`}>@</span>
                )}
                {m.group_id && mentions.length === 0 && m.status === 'group_message' && (
                  <span className={`${styles.mentionChip} ${styles.mentionNone}`}>-</span>
                )}
              </td>
              <td className={styles.payloadCell}>{payloadSummary(m.payload)}</td>
            </tr>)
          })}
        </tbody>
      </table>
      </div>
      {filters.mentionFilter && filteredMessages.length < messages.length && (
        <div className={styles.filteredNotice}>
          已筛选: 显示 {filteredMessages.length}/{messages.length} 条
        </div>
      )}

      <div className={styles.pagination}>
        <div>第 {page + 1} / {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))} 页 · 共 {totalCount} 条</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}
          >上一页</Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasMore}
            onClick={() => setPage(p => p + 1)}
          >下一页</Button>
        </div>
      </div>

      {selected && (
        <>
          <div className={styles.detailOverlay} onClick={() => setSelectedId(null)} />
          <div className={styles.detailPanel}>
            <div className={styles.detailHeader}>
              <h3 className={styles.detailTitle}>消息详情</h3>
              <Button variant="ghost" size="sm" iconOnly onClick={() => setSelectedId(null)} title="关闭">×</Button>
            </div>
            <div className={styles.detailBody}>
              <div className={styles.detailGrid}>
                <div className={styles.detailLabel}>requestId</div>
                <div className={styles.detailValue}>{selected.request_id || '—'}</div>
                <div className={styles.detailLabel}>时间</div>
                <div className={styles.detailValue}>{(() => {
                  const { date, time } = formatTsParts(selected.timestamp)
                  return time ? `${date} ${time}` : date
                })()}</div>
                <div className={styles.detailLabel}>发送方</div>
                <div className={styles.detailValue}>{selected.from_name || '—'} {selected.from_domain ? `(${selected.from_domain})` : ''}</div>
                <div className={styles.detailLabel}>接收方</div>
                <div className={styles.detailValue}>{selected.to_name || '—'} {selected.to_domain ? `(${selected.to_domain})` : ''}</div>
                <div className={styles.detailLabel}>来源</div>
                <div className={styles.detailValue}>{selected.source || '—'}</div>
                <div className={styles.detailLabel}>路由类型</div>
                <div className={styles.detailValue}>{selected.route_type}</div>
                <div className={styles.detailLabel}>群</div>
                <div className={styles.detailValue}>{selected.group_id ? `${groupNameById(selected.group_id)} (${selected.group_id})` : '—'}</div>
                <div className={styles.detailLabel}>方向 / 状态</div>
                <div className={styles.detailValue}>{selected.direction || '—'} / {selected.status || '—'}</div>
                <div className={styles.detailLabel}>延迟</div>
                <div className={styles.detailValue}>{selected.latency_ms !== undefined && selected.latency_ms !== null ? `${selected.latency_ms} ms` : '—'}</div>
              </div>
              <pre className={styles.payloadPre}>{
                (() => {
                  const parsed = safeParse(selected.payload)
                  if (typeof parsed === 'string') return parsed
                  return JSON.stringify(parsed, null, 2)
                })()
              }</pre>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
