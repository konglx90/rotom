/**
 * MemoryPanel — 内嵌记忆管理面板(process panel 的 Memory tab 内容)。
 *
 * 风格沿用 NotePanel/IssuePanel:noteItem 列表(mint hover + 绿色 active 左边框)
 * + NoteDetail 式 master-detail(header + meta + body)。
 *
 * 设计:统一扁平列表 + 顶部 filter 下拉。
 *   - 默认拉取群内 (memory + note + pending) + 全局共享,客户端按 filter 切片。
 *   - 顶部 filter 下拉:全部 / 记忆 / 便签 / 全局 / 待审核,默认「全部」。
 *     label 末尾拼计数(如「全部 (12)」);搜索中下拉禁用、计数隐藏。
 *   - 每条用 badge 标识 category(事实/决策/约定/踩坑/待办/工作流/便签)
 *     + 作用域(全局)。注:backend 设计上 category=note 与 agent_visible=0 是同义的,
 *     所以「便签」类目只在 catChip 上画一个,不再叠 scopeChip「便签」。
 *   - 新建表单用下拉选 scope (记忆 / 便签 / 全局),不再依赖当前筛选 tab。
 *   - 待审核条目保留「通过/拒绝」操作;其它条目可「提升全局 / 编辑 / 删除」。
 *   - 搜索框保留(走 backend memoryApi.search,agent_visible=1 强制约束)。
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { memoryApi, type MemoryIndex, type MemoryRow, type MemoryCategory } from '../../api/memory'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { Select } from '../../components/ui/Select'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import styles from './MemoryPanel.module.css'

interface Props {
  selectedGroupId: string
  myAgentName: string
}

/** 顶部筛选维度。 */
type Filter = 'all' | 'memory' | 'note' | 'global' | 'pending'

/** 新建表单用的 scope 选项(对应 backend visibility + agent_visible + scope 组合)。 */
type CreateScope = 'memory' | 'note' | 'global'

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
  // backend 设计上 category=note 与 agent_visible=0 是同一个概念(便签),
  // 所以 row 上 catChip 显示「便签」就够了,不再单独画 scopeChip「便签」。
  note: '便签',
}

/**
 * 每个 category 一个独立色相,饱和度/明度调成柔和版,保证 7 个互不撞色。
 * 形式:CSS class 名后缀 → 配色见 MemoryPanel.module.css `cat-foo` 规则。
 */
const CATEGORY_CLASS: Record<MemoryCategory, string> = {
  fact: 'catFact',
  decision: 'catDecision',
  convention: 'catConvention',
  pitfall: 'catPitfall',
  todo: 'catTodo',
  playbook: 'catPlaybook',
  note: 'catNote',
}

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部',
  memory: '记忆',
  note: '便签',
  global: '全局',
  pending: '待审核',
}

/** 行 → filter 切片判定。 */
function rowMatchesFilter(r: ListRow, f: Filter): boolean {
  const isPending = r.pending_review === 1
  if (isPending) return f === 'all' || f === 'pending'
  if (f === 'pending') return false
  if (f === 'global') return r.scope === 'global'
  if (f === 'note') return r.category === 'note'
  if (f === 'memory') return r.category !== 'note' && r.scope !== 'global'
  return true // 'all'
}

export function MemoryPanel({ selectedGroupId, myAgentName }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
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
      // 一次拉全:群内(memory + note)+ 全局共享 + 待审核(单独 endpoint 拉,client 端打 pending_review=1),客户端按 filter 切片
      const [group, globals, pending] = await Promise.all([
        memoryApi.listGroup(selectedGroupId, { type: 'all' }),
        memoryApi.listGlobal({ type: 'all' }),
        memoryApi.listPending(selectedGroupId).catch(() => [] as MemoryIndex[]),
      ])
      const pendingTagged: ListRow[] = pending.map(r => ({ ...r, pending_review: 1 }))
      // 同 id 优先用 pendingTagged(listPending 返回的就是审核队列,字段最准)。
      const byId = new Map<string, ListRow>()
      for (const r of [...group, ...globals]) byId.set(r.id, r)
      for (const r of pendingTagged) byId.set(r.id, r)
      setRows(Array.from(byId.values()))
    } catch (e) {
      setError((e as Error).message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [selectedGroupId])

  useEffect(() => {
    setSelectedId('')
    setCreating(false)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

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
  const sourceRows = isSearching ? searchHits! : rows
  const displayRows = useMemo(
    () => sourceRows.filter(r => rowMatchesFilter(r, filter)),
    [sourceRows, filter],
  )

  // 顶部各 filter 计数(用于徽标 / 排序参考)。搜索中隐藏计数。
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, memory: 0, note: 0, global: 0, pending: 0 }
    for (const r of sourceRows) {
      for (const f of Object.keys(c) as Filter[]) {
        if (rowMatchesFilter(r, f)) c[f] += 1
      }
    }
    return c
  }, [sourceRows])

  const selectedRow = useMemo(
    () => sourceRows.find(r => r.id === selectedId),
    [sourceRows, selectedId],
  )
  const selectedIsPending = selectedRow?.pending_review === 1

  return (
    <div className={styles.memoryPanel}>
      {/* ── header:filter dropdown + 搜索 + 新建 ─────────────────────── */}
      <div className={styles.header}>
        <Select
          size="sm"
          className={styles.filterSelect}
          value={filter}
          disabled={isSearching}
          onChange={e => {
            const next = e.target.value as Filter
            setFilter(next)
            setSearchHits(null)
            setSearchKw('')
          }}
        >
          {(['all', 'memory', 'note', 'global', 'pending'] as Filter[]).map(f => (
            <option key={f} value={f}>
              {FILTER_LABEL[f]}{isSearching ? '' : ` (${counts[f]})`}
            </option>
          ))}
        </Select>
        <div className={styles.headerRight}>
          <Input
            size="sm"
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
          {!isSearching && !selectedId && (
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>+ 新建</Button>
          )}
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* ── body:列表 / 详情 / 新建 ─────────────────────────── */}
      <div className={styles.body}>
        {selectedId ? (
          <MemoryDetail
            id={selectedId}
            isPending={selectedIsPending}
            onBack={() => setSelectedId('')}
            onChanged={reload}
          />
        ) : creating ? (
          <MemoryEditor
            mode="create"
            onCancel={() => setCreating(false)}
            onSaved={async (data) => {
              try {
                const base = {
                  key: data.key,
                  value: data.value,
                  category: data.category,
                  summary: data.summary,
                  tags: data.tags,
                  createdBy: myAgentName,
                }
                if (data.scope === 'global') {
                  await memoryApi.createGlobal({
                    ...base,
                    visibility: 'global',
                    agentVisible: true,
                  })
                } else if (data.scope === 'note') {
                  await memoryApi.createGroup(selectedGroupId, {
                    ...base,
                    visibility: 'group',
                    agentVisible: false,
                  })
                } else {
                  await memoryApi.createGroup(selectedGroupId, {
                    ...base,
                    visibility: 'group',
                    agentVisible: true,
                  })
                }
                setCreating(false)
                reload()
              } catch (e) { setError((e as Error).message) }
            }}
          />
        ) : loading ? (
          <div className={styles.empty}>加载中...</div>
        ) : displayRows.length === 0 ? (
          <div className={styles.empty}>
            {isSearching ? '没有匹配的记忆' : '暂无记忆条目'}
          </div>
        ) : (
          <ul className={styles.list}>
            {displayRows.map(r => {
              const isPending = r.pending_review === 1
              const isGlobal = r.scope === 'global'
              return (
                <li
                  key={r.id}
                  className={`${styles.item} ${isPending ? styles.itemPending : ''}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  {/* 顶行:分类 chip + 作用域 chip + 标题 + 待审核右上角徽章 */}
                  <div className={styles.itemTitleRow}>
                    <span className={`${styles.catChip} ${styles[CATEGORY_CLASS[r.category]]}`}>
                      {CATEGORY_LABEL[r.category]}
                    </span>
                    <span className={styles.itemKey}>{r.key}</span>
                    {!isPending && isGlobal && (
                      <span className={`${styles.scopeChip} ${styles.scopeGlobal}`}>全局</span>
                    )}
                    {/* category=note 的 item 已被 catChip 表达为「便签」,不再画 scopeChip,避免重复 */}
                    {/* 便签默认仅人类可见(常见态)显示「📝 仅人类」;少数勾上 agent_visible=1 的不重复打,避免噪音 */}
                    {!isPending && r.category === 'note' && r.agent_visible === 0 && (
                      <span className={`${styles.scopeChip} ${styles.noteHumanOnly}`}>📝 仅人类</span>
                    )}
                    {isPending && <span className={styles.pendingCorner}>待审核</span>}
                  </div>
                  {r.summary && <div className={styles.itemSummary}>{r.summary}</div>}
                  <div className={styles.itemMeta}>
                    <span>{r.created_by ?? ''}</span>
                    <span>·</span>
                    <span>{r.created_at.slice(0, 16).replace('T', ' ')}</span>
                    {r.group_id && !isGlobal && <><span>·</span><span>群 {r.group_id.slice(0, 8)}</span></>}
                  </div>
                </li>
              )
            })}
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
  scope: CreateScope
}

const SCOPE_LABEL: Record<CreateScope, string> = {
  memory: '记忆(群内,agent 可见)',
  note: '便签(群内,纯人看)',
  global: '全局(跨群共享,agent 可见)',
}

function MemoryEditor({ mode, row, onCancel, onSaved }: {
  mode: 'create' | 'edit'
  row?: MemoryRow
  onCancel: () => void
  onSaved: (data: FormData) => void
}) {
  const initialScope: CreateScope = row
    ? (row.scope === 'global' ? 'global' : row.agent_visible === 0 ? 'note' : 'memory')
    : 'memory'

  const [form, setForm] = useState<FormData>({
    key: row?.key ?? '',
    value: row?.value ?? '',
    summary: row?.summary ?? '',
    category: row?.category ?? 'note',
    tags: row?.tags ? safeParseTags(row.tags) : [],
    scope: initialScope,
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
        <div className={styles.field}>
          <span className={styles.fieldLabel}>作用域(scope)</span>
          <Select
            size="sm"
            value={form.scope}
            disabled={mode === 'edit'}
            onChange={e => setForm({ ...form, scope: e.target.value as CreateScope })}
            options={(Object.keys(SCOPE_LABEL) as CreateScope[]).map(s => ({ value: s, label: SCOPE_LABEL[s] }))}
          />
          {mode === 'edit' && (
            <span className={styles.fieldHint}>编辑模式下不可改 scope,如需变更请删除后重建。</span>
          )}
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>key (主题)</span>
          <Input size="sm" value={form.key} onChange={e => setForm({ ...form, key: e.target.value })} />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>summary (一句话摘要,留空自动取 value 前 80 字)</span>
          <Input size="sm" value={form.summary} onChange={e => setForm({ ...form, summary: e.target.value })} />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>category</span>
          <Select
            size="sm"
            value={form.category}
            onChange={e => setForm({ ...form, category: e.target.value as MemoryCategory })}
            options={CATEGORIES.map(c => ({ value: c, label: `${CATEGORY_LABEL[c]} (${c})` }))}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>value (内容,Markdown)</span>
          <Textarea
            rows={10}
            value={form.value}
            onChange={e => setForm({ ...form, value: e.target.value })}
            spellCheck={false}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>tags (逗号分隔)</span>
          <Input
            size="sm"
            value={form.tags.join(', ')}
            onChange={e => setForm({ ...form, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
          />
        </div>
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
