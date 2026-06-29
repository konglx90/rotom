/**
 * MemoryPanel — 内嵌记忆管理面板(process panel 的 Memory tab 内容)。
 *
 * 风格沿用 NotePanel/IssuePanel:noteItem 列表(mint hover + 绿色 active 左边框)
 * + NoteDetail 式 master-detail(header + meta + body)。
 *
 * 四个 sub-tab:
 *   记忆 (memory, agent_visible=1)  — agent 可见,走 search/注入
 *   便签 (note,   agent_visible=0)  — 纯人看,agent 搜不到
 *   全局 (global, agent_visible=1)  — 跨群共享
 *   待审核 (pending_review=1)       — Issue 提取的候选,需 approve
 *
 * 取代旧 NotePanel:note 是其中"便签"子视图,memory 是升级版 agent 可见记忆。
 */
import { useEffect, useState, useCallback } from 'react'
import { memoryApi, type MemoryIndex, type MemoryRow, type MemoryCategory } from '../../api/memory'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import styles from './MemoryPanel.module.css'

interface Props {
  selectedGroupId: string
  myAgentName: string
}

type Tab = 'memory' | 'note' | 'global' | 'pending'

const CATEGORIES: MemoryCategory[] = ['fact', 'decision', 'convention', 'pitfall', 'todo', 'playbook', 'note']

/** listMemory/search/listPending 都返回 MemoryIndex,但 pending 列表需要 pending_review 标记。 */
type ListRow = MemoryIndex & { pending_review?: number }

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  fact: '事实',
  decision: '决策',
  convention: '约定',
  pitfall: '踩坑',
  todo: '待办',
  playbook: '工作流',
  note: '便签',
}

export function MemoryPanel({ selectedGroupId, myAgentName }: Props) {
  const [tab, setTab] = useState<Tab>('memory')
  const [rows, setRows] = useState<ListRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [creating, setCreating] = useState(false)
  const [searchKw, setSearchKw] = useState('')
  const [searchHits, setSearchHits] = useState<ListRow[] | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let data: MemoryIndex[]
      if (tab === 'memory') data = await memoryApi.listGroup(selectedGroupId, { type: 'memory' })
      else if (tab === 'note') data = await memoryApi.listGroup(selectedGroupId, { type: 'note' })
      else if (tab === 'global') data = await memoryApi.listGlobal({ type: 'memory' })
      else data = await memoryApi.listPending(selectedGroupId)
      setRows(data)
    } catch (e) {
      setError((e as Error).message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [tab, selectedGroupId])

  useEffect(() => {
    setSelectedId('')
    setCreating(false)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedGroupId])

  const doSearch = async () => {
    if (!searchKw.trim()) { setSearchHits(null); return }
    try {
      const { group, global } = await memoryApi.search(searchKw.trim(), selectedGroupId)
      setSearchHits([...group, ...global])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const isSearching = searchHits !== null
  const displayRows = isSearching ? searchHits! : rows

  const showCreate = (tab === 'memory' || tab === 'note' || tab === 'global') && !isSearching

  return (
    <div className={styles.memoryPanel}>
      {/* ── header:sub-tabs + 搜索 + 新建 ─────────────────────────── */}
      <div className={styles.header}>
        <div className={styles.tabs}>
          {(['memory', 'note', 'global', 'pending'] as Tab[]).map(t => (
            <button
              key={t}
              type="button"
              className={`${styles.tab} ${tab === t && !isSearching ? styles.tabActive : ''}`}
              onClick={() => { setTab(t); setSearchHits(null); setSearchKw('') }}
            >
              {t === 'memory' ? '记忆' : t === 'note' ? '便签' : t === 'global' ? '全局' : '待审核'}
            </button>
          ))}
        </div>
        <div className={styles.headerRight}>
          <input
            className={styles.searchInput}
            placeholder="搜索记忆"
            value={searchKw}
            onChange={e => setSearchKw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doSearch() }}
          />
          {isSearching && (
            <button className={styles.clearBtn} onClick={() => { setSearchHits(null); setSearchKw('') }}>
              清除
            </button>
          )}
          {showCreate && !selectedId && (
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>+ 新建</Button>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* ── body:列表 / 详情 / 新建 ───────────────────────────────── */}
      <div className={styles.body}>
        {creating ? (
          <MemoryEditor
            mode="create"
            defaultAgentVisible={tab === 'note' ? false : true}
            defaultScope={tab === 'global' ? 'global' : 'group'}
            onCancel={() => setCreating(false)}
            onSaved={async (data) => {
              try {
                const input = { ...data, createdBy: myAgentName }
                if (data.scope === 'global') await memoryApi.createGlobal(input)
                else await memoryApi.createGroup(selectedGroupId, input)
                setCreating(false)
                await reload()
              } catch (e) {
                setError((e as Error).message)
              }
            }}
          />
        ) : selectedId ? (
          <MemoryDetail
            id={selectedId}
            isPending={tab === 'pending'}
            onBack={() => setSelectedId('')}
            onChanged={reload}
          />
        ) : loading ? (
          <div className={styles.empty}>加载中...</div>
        ) : displayRows.length === 0 ? (
          <div className={styles.empty}>
            {isSearching ? '没有匹配的记忆' :
             tab === 'memory' ? '暂无记忆(agent 可见)' :
             tab === 'note' ? '暂无便签(纯人看)' :
             tab === 'global' ? '暂无全局记忆' :
             '暂无待审核候选'}
          </div>
        ) : (
          <ul className={styles.list}>
            {displayRows.map(r => (
              <li
                key={r.id}
                className={styles.item}
                onClick={() => setSelectedId(r.id)}
              >
                <div className={styles.itemTitleRow}>
                  <span className={styles.catBadge}>{CATEGORY_LABEL[r.category]}</span>
                  <span className={styles.itemKey}>{r.key}</span>
                  {r.scope === 'global' && <span className={styles.scopeBadge}>全局</span>}
                  {!r.agent_visible && <span className={styles.noteBadge}>便签</span>}
                  {r.pending_review === 1 && <span className={styles.pendingBadge}>待审核</span>}
                </div>
                {r.summary && <div className={styles.itemSummary}>{r.summary}</div>}
                <div className={styles.itemMeta}>
                  <span>{r.created_by ?? ''}</span>
                  <span>·</span>
                  <span>{r.created_at.slice(0, 16).replace('T', ' ')}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── 详情视图(沿用 NoteDetail 结构)──────────────────────────────────────
function MemoryDetail({ id, isPending, onBack, onChanged }: {
  id: string
  isPending: boolean
  onBack: () => void
  onChanged: () => void
}) {
  const [row, setRow] = useState<MemoryRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const refetch = () => {
    setLoading(true)
    setErr(null)
    memoryApi.getById(id)
      .then(d => { setRow(d); setLoading(false) })
      .catch(e => { setErr((e as Error).message); setLoading(false) })
  }

  useEffect(() => { refetch() }, [id])

  const handleDelete = async () => {
    if (!window.confirm('确认删除这条记录?(软删除)')) return
    try {
      await memoryApi.remove(id)
      onChanged()
      onBack()
    } catch (e) { setErr((e as Error).message) }
  }

  const handleApprove = async () => {
    try { await memoryApi.approve(id); onChanged(); onBack() }
    catch (e) { setErr((e as Error).message) }
  }

  const handleReject = async () => {
    if (!window.confirm('拒绝这条候选?(软删除)')) return
    try { await memoryApi.reject(id); onChanged(); onBack() }
    catch (e) { setErr((e as Error).message) }
  }

  const handlePromote = async () => {
    if (!window.confirm('提升为全局共享?(所有群的 agent 可见)')) return
    try { await memoryApi.promote(id, 'global'); refetch() }
    catch (e) { setErr((e as Error).message) }
  }

  if (loading) return <div className={styles.empty}>加载中...</div>
  if (err || !row) return <div className={styles.empty}>{err ?? '加载失败'}</div>

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <button className={styles.backBtn} onClick={onBack}>← 返回</button>
        <span className={styles.detailTitle} onClick={() => setEditing(true)} title="点击编辑">
          {row.key}
        </span>
        <div className={styles.detailActions}>
          {isPending ? (
            <>
              <Button variant="success" size="sm" onClick={handleApprove}>通过</Button>
              <Button variant="danger" size="sm" onClick={handleReject}>拒绝</Button>
            </>
          ) : (
            <>
              {row.scope === 'group' && row.agent_visible === 1 && (
                <Button variant="ghost" size="sm" onClick={handlePromote}>提升全局</Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>编辑</Button>
              <Button variant="ghost" size="sm" onClick={handleDelete}>删除</Button>
            </>
          )}
        </div>
      </div>
      <div className={styles.detailMeta}>
        {CATEGORY_LABEL[row.category]} · {row.scope === 'global' ? '全局' : '群内'} · {row.agent_visible ? '🧠 记忆(agent 可见)' : '📝 便签(纯人看)'} · 创建者:{row.created_by ?? ''} · 更新:{row.updated_at.slice(0, 16).replace('T', ' ')}
      </div>
      {err && <div className={styles.error}>{err}</div>}
      {editing ? (
        <MemoryEditor
          mode="edit"
          row={row}
          onCancel={() => setEditing(false)}
          onSaved={async (data) => {
            try {
              await memoryApi.update(id, data)
              setEditing(false)
              refetch()
              onChanged()
            } catch (e) { setErr((e as Error).message) }
          }}
        />
      ) : (
        <div className={styles.detailBody}>
          {row.summary && (
            <div className={styles.detailSummary}>{row.summary}</div>
          )}
          {row.value.trim() ? (
            <MarkdownContent content={row.value} />
          ) : (
            <span style={{ color: 'var(--color-gray)', fontSize: 13 }}>（暂无内容,点击右上角编辑）</span>
          )}
          {row.tags && JSON.parse(row.tags).length > 0 && (
            <div className={styles.detailTags}>
              {JSON.parse(row.tags).map((t: string) => (
                <span key={t} className={styles.tagChip}>{t}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 新建/编辑表单 ──────────────────────────────────────────────────────
interface FormData {
  key: string
  value: string
  summary: string
  category: MemoryCategory
  tags: string[]
  visibility: 'private' | 'group' | 'global'
  agentVisible: boolean
  scope: 'group' | 'global'
}

function MemoryEditor({ mode, row, defaultAgentVisible, defaultScope, onCancel, onSaved }: {
  mode: 'create' | 'edit'
  row?: MemoryRow
  defaultAgentVisible?: boolean
  defaultScope?: 'group' | 'global'
  onCancel: () => void
  onSaved: (data: FormData) => void
}) {
  const [form, setForm] = useState<FormData>({
    key: row?.key ?? '',
    value: row?.value ?? '',
    summary: row?.summary ?? '',
    category: row?.category ?? 'note',
    tags: row?.tags ? safeParseTags(row.tags) : [],
    visibility: row?.visibility ?? 'group',
    agentVisible: row ? row.agent_visible === 1 : (defaultAgentVisible ?? true),
    scope: row?.scope ?? (defaultScope ?? 'group'),
  })
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    if (!form.key.trim()) { setErr('key 不能为空'); return }
    onSaved(form)
  }

  return (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <span className={styles.editorTitle}>{mode === 'create' ? '新建' : '编辑'}</span>
      </div>
      {err && <div className={styles.error}>{err}</div>}
      <div className={styles.editorBody}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>key (主题)</span>
          <input className={styles.input} value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>summary (一句话摘要,留空自动取 value 前 80 字)</span>
          <input className={styles.input} value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>category</span>
          <select className={styles.select} value={form.category} onChange={e => setForm({ ...form, category: e.target.value as MemoryCategory })}>
            {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABEL[c]} ({c})</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>value (内容,Markdown)</span>
          <textarea className={styles.textarea} rows={10} value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>tags (逗号分隔)</span>
          <input
            className={styles.input}
            value={form.tags.join(', ')}
            onChange={e => setForm({ ...form, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>visibility</span>
          <select className={styles.select} value={form.visibility} onChange={e => setForm({ ...form, visibility: e.target.value as FormData['visibility'] })}>
            <option value="private">private (仅创建者)</option>
            <option value="group">group (群内)</option>
            <option value="global">global (跨群)</option>
          </select>
        </label>
        <label className={styles.fieldRow}>
          <input
            type="checkbox"
            checked={form.agentVisible}
            onChange={e => setForm({ ...form, agentVisible: e.target.checked })}
          />
          <span>agent 可见(memory,走 search/注入);不勾选 = 便签(纯人看,agent 搜不到)</span>
        </label>
      </div>
      <div className={styles.editorActions}>
        <Button variant="secondary" size="sm" onClick={onCancel}>取消</Button>
        <Button variant="primary" size="sm" onClick={submit}>{mode === 'create' ? '创建' : '保存'}</Button>
      </div>
    </div>
  )
}

function safeParseTags(s: string): string[] {
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}
