/**
 * Memory 管理 Tab —— 全局视角看所有 memory(按群 + global)。
 *
 * 与群内 MemoryPanel 互补:这里是跨群汇总,用于审计/管理所有 agent 可见的记忆 + 待审核队列。
 *
 * 设计:统一扁平列表 + 顶部筛选按钮(全部 / 记忆 / 便签 / 全局 / 待审核)。
 *   - 不选群时默认展示全局 + 所有群;选群后只展示该群 + 全局。
 *   - 每条带 category / scope(全局/便签/待审核)badge。
 *   - 待审核条目保留「通过/拒绝」,其它条目保留「查看/删除」,全局条目隐藏删除(从 MemoryPanel 同步)。
 *   - 新建不在这里(群内 Memory tab 负责),保持只读审计定位。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { memoryApi } from '../../api/memory'
import { groupsApi } from '../../api/groups'
import type { MemoryIndex, MemoryRow, MemoryCategory } from '../../api/memory'
import styles from './ManagementTab.module.css'

interface GroupInfo { id: string; name: string }

type Filter = 'all' | 'memory' | 'note' | 'global' | 'pending'
type ListRow = MemoryIndex & { pending_review?: number }

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部',
  memory: '记忆',
  note: '便签',
  global: '全局',
  pending: '待审核',
}

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  fact: '事实',
  decision: '决策',
  convention: '约定',
  pitfall: '踩坑',
  todo: '待办',
  playbook: '工作流',
  // backend 设计上 category=note 与 agent_visible=0 是同一个概念(便签),
  // 所以 catChip 显示「便签」就够了,不再叠 scopeChip「便签」。
  note: '便签',
}

/** 与 MemoryPanel 保持一致的 category 配色映射。 */
const CATEGORY_CLASS: Record<MemoryCategory, string> = {
  fact: 'catFact',
  decision: 'catDecision',
  convention: 'catConvention',
  pitfall: 'catPitfall',
  todo: 'catTodo',
  playbook: 'catPlaybook',
  note: 'catNote',
}

function rowMatchesFilter(r: ListRow, f: Filter): boolean {
  const isPending = r.pending_review === 1
  if (isPending) return f === 'all' || f === 'pending'
  if (f === 'pending') return false
  if (f === 'global') return r.scope === 'global'
  if (f === 'note') return r.agent_visible === 0
  if (f === 'memory') return r.agent_visible === 1 && r.scope !== 'global'
  return true
}

export function MemoryManagementTab() {
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [selectedGroupId, setSel] = useState<string>('')
  const [rows, setRows] = useState<ListRow[]>([])
  const [pending, setPending] = useState<ListRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<MemoryRow | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    groupsApi.list().then((gs: any) => setGroups((gs ?? []).map((g: any) => ({ id: g.id, name: g.name })))).catch(() => {})
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 全平台 pending(不限群):listPending 不带 groupId 时返回全平台候选。
      const [globals, groupRows, pending] = await Promise.all([
        memoryApi.listGlobal({ type: 'all' }),
        selectedGroupId
          ? memoryApi.listGroup(selectedGroupId, { type: 'all' })
          : Promise.resolve([] as MemoryIndex[]),
        memoryApi.listAllPending().catch(() => [] as MemoryIndex[]),
      ])
      const pendingTagged: ListRow[] = pending.map(r => ({ ...r, pending_review: 1 }))
      setRows([...groupRows, ...globals])
      setPending(pendingTagged)
    } catch (e) {
      setError((e as Error).message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [selectedGroupId])

  useEffect(() => { reload() }, [reload])

  const openView = async (id: string) => {
    try { setViewing(await memoryApi.getById(id)) }
    catch (e) { setError((e as Error).message) }
  }

  const approve = async (id: string) => { await memoryApi.approve(id); await reload() }
  const reject = async (id: string) => { if (confirm('拒绝?软删除')) { await memoryApi.reject(id); await reload() } }
  const remove = async (id: string) => { if (confirm('删除?软删除')) { await memoryApi.remove(id); await reload() } }

  // 合并所有来源(群内 / 全局 / 待审核)→ 按 filter 切片。
  const allRows = useMemo<ListRow[]>(() => {
    const map = new Map<string, ListRow>()
    for (const r of rows) map.set(r.id, r)
    for (const r of pending) map.set(r.id, r)
    return Array.from(map.values())
  }, [rows, pending])

  const displayRows = useMemo(
    () => allRows.filter(r => rowMatchesFilter(r, filter)),
    [allRows, filter],
  )

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, memory: 0, note: 0, global: 0, pending: 0 }
    for (const r of allRows) {
      for (const f of Object.keys(c) as Filter[]) {
        if (rowMatchesFilter(r, f)) c[f] += 1
      }
    }
    return c
  }, [allRows])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>记忆(Memory)</h2>
          <p className={styles.subheading}>
            全局视角:选择群后只显示该群 + 全局共享;不选群时显示全部。
            群内新建/编辑请进群的 Memory tab。这里用于跨群审计与审核。
          </p>
        </div>
        <select className={styles.input} style={{ width: 220 }} value={selectedGroupId} onChange={e => setSel(e.target.value)}>
          <option value="">— 全部群 —</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.tabs}>
        {(['all', 'memory', 'note', 'global', 'pending'] as Filter[]).map(f => (
          <button
            key={f}
            type="button"
            className={`${styles.tab} ${filter === f ? styles.tabActive : ''}`}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABEL[f]}
            <span className={styles.tabCount}>{counts[f]}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className={styles.empty}>加载中...</div>
      ) : displayRows.length === 0 ? (
        <div className={styles.empty}>暂无记忆条目</div>
      ) : (
        <div className={styles.list}>
          {displayRows.map(m => {
            const isPending = m.pending_review === 1
            const isGlobal = m.scope === 'global'
            return (
              <div
                key={m.id}
                className={`${styles.card} ${isPending ? styles.cardPending : ''}`}
              >
                <div className={styles.cardHeader}>
                  <span className={`${styles.catChip} ${styles[CATEGORY_CLASS[m.category]]}`}>
                    {CATEGORY_LABEL[m.category]}
                  </span>
                  <span className={styles.cardName}>{m.key}</span>
                  {!isPending && isGlobal && (
                    <span className={`${styles.scopeChip} ${styles.scopeGlobal}`}>全局</span>
                  )}
                  {/* category=note 的 item 已被 catChip 表达为「便签」,不再画 scopeChip,避免重复 */}
                  {isPending && <span className={styles.pendingCorner}>待审核</span>}
                </div>
                {m.summary && <div className={styles.cardDesc}>{m.summary}</div>}
                <div className={styles.cardMeta}>
                  <span>{m.created_by ?? ''}</span>
                  <span>·</span>
                  <span>{m.created_at.slice(0, 16).replace('T', ' ')}</span>
                  {m.group_id && !isGlobal && <><span>·</span><span>群 {m.group_id.slice(0, 8)}</span></>}
                </div>
                <div className={styles.cardActions}>
                  <Button variant="ghost" size="xs" onClick={() => openView(m.id)}>查看</Button>
                  {isPending ? (
                    <>
                      <Button variant="success" size="xs" onClick={() => approve(m.id)}>通过</Button>
                      <Button variant="danger" size="xs" onClick={() => reject(m.id)}>拒绝</Button>
                    </>
                  ) : (
                    !isGlobal && <Button variant="ghost" size="xs" onClick={() => remove(m.id)}>删除</Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {viewing && (
        <Modal open={true} title={`记忆 · ${viewing.key}`} onClose={() => setViewing(null)} size="lg">
          <div className={styles.cardDesc}>{viewing.summary}</div>
          <div className={styles.cardPrompt} style={{ marginTop: 8 }}>
            <MarkdownContent content={viewing.value} />
          </div>
        </Modal>
      )}
    </div>
  )
}
