/**
 * Memory 管理 Tab —— 全局视角看所有 memory(按群 + global)。
 *
 * 与群内 MemoryPanel 互补:这里是跨群汇总,用于审计/管理所有 agent 可见的记忆 + 待审核队列。
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { memoryApi } from '../../api/memory'
import { groupsApi } from '../../api/groups'
import type { MemoryIndex, MemoryRow } from '../../api/memory'
import styles from './ManagementTab.module.css'

interface GroupInfo { id: string; name: string }

export function MemoryManagementTab() {
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [selectedGroupId, setSel] = useState<string>('')
  const [rows, setRows] = useState<MemoryIndex[]>([])
  const [globals, setGlobals] = useState<MemoryIndex[]>([])
  const [pending, setPending] = useState<MemoryIndex[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<MemoryRow | null>(null)

  useEffect(() => {
    groupsApi.list().then((gs: any) => setGroups((gs ?? []).map((g: any) => ({ id: g.id, name: g.name })))).catch(() => {})
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [g, pend] = await Promise.all([
        memoryApi.listGlobal({ type: 'all' }),
        selectedGroupId
          ? memoryApi.listPending(selectedGroupId)
          : Promise.resolve([] as MemoryIndex[]),
      ])
      setGlobals(g)
      setPending(pend)
      if (selectedGroupId) {
        setRows(await memoryApi.listGroup(selectedGroupId, { type: 'all' }))
      } else {
        setRows([])
      }
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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>记忆(Memory)</h2>
          <p className={styles.subheading}>
            全局视角:选择群看该群记忆 + 全局共享记忆 + 待审核队列。
            群内新建/编辑请进群的 Memory tab。这里用于跨群审计与审核。
          </p>
        </div>
        <select className={styles.input} style={{ width: 220 }} value={selectedGroupId} onChange={e => setSel(e.target.value)}>
          <option value="">— 选择群 —</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.empty}>加载中...</div>}

      {/* 待审核 */}
      <h3 style={{ fontSize: 14, margin: 0 }}>待审核({pending.length})</h3>
      {pending.length === 0 ? <div className={styles.empty}>无待审核</div> : (
        <div className={styles.list}>
          {pending.map(m => (
            <div key={m.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.badgeDefault}>{m.category}</span>
                <span className={styles.cardName}>{m.key}</span>
                <span className={styles.badgeSchedule}>待审核</span>
              </div>
              <div className={styles.cardDesc}>{m.summary}</div>
              <div className={styles.cardActions}>
                <Button variant="ghost" size="xs" onClick={() => openView(m.id)}>查看</Button>
                <Button variant="success" size="xs" onClick={() => approve(m.id)}>通过</Button>
                <Button variant="danger" size="xs" onClick={() => reject(m.id)}>拒绝</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 群内记忆 */}
      {selectedGroupId && (
        <>
          <h3 style={{ fontSize: 14, margin: 0 }}>群内记忆({rows.length})</h3>
          <div className={styles.list}>
            {rows.map(m => <MemCard key={m.id} m={m} onView={openView} onDelete={remove} />)}
          </div>
        </>
      )}

      {/* 全局记忆 */}
      <h3 style={{ fontSize: 14, margin: 0 }}>全局共享记忆({globals.length})</h3>
      <div className={styles.list}>
        {globals.map(m => <MemCard key={m.id} m={m} onView={openView} onDelete={remove} />)}
      </div>

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

function MemCard({ m, onView, onDelete }: { m: MemoryIndex; onView: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.badgeDefault}>{m.category}</span>
        <span className={styles.cardName}>{m.key}</span>
        <span className={styles.badgeSchedule}>{m.agent_visible ? '记忆' : '便签'}</span>
      </div>
      <div className={styles.cardDesc}>{m.summary}</div>
      <div className={styles.cardActions}>
        <Button variant="ghost" size="xs" onClick={() => onView(m.id)}>查看</Button>
        <Button variant="ghost" size="xs" onClick={() => onDelete(m.id)}>删除</Button>
      </div>
    </div>
  )
}
