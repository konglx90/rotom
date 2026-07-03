/**
 * Skills 管理 Tab —— 全局 skill 知识库 CRUD + 绑定关系总览。
 *
 * skill 是全局能力资产,无可见性。绑定关系在某群的群设置 modal 里勾选。
 * 这里是全局视角:看所有 skill、谁绑了、查看/编辑 content、promote from memory。
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import { skillsApi } from '../../api/skills'
import { memoryApi } from '../../api/memory'
import type { MemoryIndex } from '../../api/memory'
import type { SkillIndex as SIdx, SkillBinding as SB, SkillRow } from '../../api/skills'
import { useChatContext } from '../../context/ChatContext'
import styles from './ManagementTab.module.css'

interface EditState {
  isCreate: boolean
  originalName: string
  name: string
  description: string
  content: string
  category: string
}

const EMPTY_EDIT: EditState = {
  isCreate: true, originalName: '', name: '', description: '', content: '', category: '',
}

// 对齐 Claude Code skill 命名:小写字母/数字/短横线,首字符非短横线
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function validateEdit(e: EditState): string | null {
  if (!e.name.trim()) return 'name 不能为空'
  if (!NAME_RE.test(e.name.trim())) return 'name 只能用小写字母/数字/短横线,首字符非短横线(禁中文/空格/斜杠)'
  if (!e.description.trim()) return 'description 不能为空(说明「做什么 + 何时用」)'
  if (e.description.trim().length > 1024) return 'description 过长(>1024)'
  if (e.isCreate && !e.content.trim()) return 'content 不能为空'
  return null
}

export function SkillsManagementTab() {
  const { myAgentName } = useChatContext()
  const [skills, setSkills] = useState<SIdx[]>([])
  const [bindings, setBindings] = useState<SB[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [viewing, setViewing] = useState<SkillRow | null>(null)
  const [promoteOpen, setPromoteOpen] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, b] = await Promise.all([skillsApi.list(), skillsApi.listAllBindings()])
      setSkills(s)
      setBindings(b)
    } catch (e) {
      setError((e as Error).message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const bindingsBySkill = new Map<string, SB[]>()
  for (const b of bindings) {
    const arr = bindingsBySkill.get(b.skill_id) ?? []
    arr.push(b)
    bindingsBySkill.set(b.skill_id, arr)
  }

  const openEdit = async (name: string) => {
    setError(null)
    try {
      const row = await skillsApi.getByName(name)
      setEditing({
        isCreate: false, originalName: name, name: row.name,
        description: row.description, content: row.content,
        category: row.category ?? '',
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleSave = async () => {
    if (!editing) return
    const verr = validateEdit(editing)
    if (verr) { setError(verr); return }
    setError(null)
    try {
      if (editing.isCreate) {
        await skillsApi.create({
          name: editing.name.trim(), description: editing.description.trim(),
          content: editing.content, category: editing.category || undefined,
          createdBy: myAgentName,
        })
      } else {
        const patch: Record<string, unknown> = {
          name: editing.name.trim(), description: editing.description.trim(),
          category: editing.category || null,
        }
        if (editing.content.trim()) patch.content = editing.content
        await skillsApi.update(editing.originalName, patch)
      }
      setEditing(null)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleDelete = async (name: string) => {
    if (!window.confirm(`删除 skill "${name}"?(软删除,绑定关系保留但不再生效)`)) return
    try {
      await skillsApi.remove(name)
      await reload()
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>技能(Skills)</h2>
          <p className={styles.subheading}>
            全局 skill 知识库。skill 本身无可见性 —— 在「群设置」里给某个 agent 勾选 skill 才会注入该 agent 的 prompt。
            playbook 类记忆可「从记忆沉淀」成 skill。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={() => setPromoteOpen(true)}>从记忆沉淀</Button>
          <Button variant="primary" size="sm" onClick={() => setEditing({ ...EMPTY_EDIT })}>+ 新建技能</Button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loading && <div className={styles.empty}>加载中...</div>}
      {!loading && skills.length === 0 && <div className={styles.empty}>暂无技能,点击右上角新建</div>}

      <div className={styles.list}>
        {skills.map(s => {
          const bs = bindingsBySkill.get(s.id) ?? []
          return (
            <div key={s.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardName}>{s.name}</span>
                {s.category && <span className={styles.badgeDefault}>{s.category}</span>}
                {s.source_type === 'promoted' && <span className={styles.badgeSchedule}>promoted</span>}
                <span className={styles.badgeSchedule}>查阅 {s.view_count}</span>
                <span className={styles.cardDesc}>· 绑定 {bs.length} 个(群,agent)</span>
              </div>
              <div className={styles.cardDesc}>{s.description}</div>
              {bs.length > 0 && (
                <div className={styles.cardSchedule}>
                  绑定:{bs.map(b => `${b.group_id.slice(0, 8)}/${b.agent_name}`).join(', ')}
                </div>
              )}
              <div className={styles.cardActions}>
                <Button variant="ghost" size="xs" onClick={() => skillsApi.getByName(s.name).then(setViewing).catch(e => setError((e as Error).message))}>查看</Button>
                <Button variant="ghost" size="xs" onClick={() => openEdit(s.name)}>编辑</Button>
                <Button variant="ghost" size="xs" onClick={() => handleDelete(s.name)}>删除</Button>
              </div>
            </div>
          )
        })}
      </div>

      {/* 编辑/新建 */}
      {editing && (
        <Modal open title={editing.isCreate ? '新建技能' : `编辑 ${editing.originalName}`} onClose={() => setEditing(null)} size="lg">
          <div className={styles.form}>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>name (小写字母/数字/短横线,禁中文)</label>
              <Input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="如 release-flow" />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>description (一句话描述)</label>
              <Input value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>category (可选)</label>
              <Input value={editing.category} onChange={e => setEditing({ ...editing, category: e.target.value })} />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>content (markdown 正文)</label>
              <Textarea
                style={{ minHeight: 240, fontFamily: 'SF Mono, Menlo, monospace', lineHeight: 1.5 }}
                value={editing.content}
                onChange={e => setEditing({ ...editing, content: e.target.value })}
              />
              {!editing.isCreate && <div className={styles.note}>编辑模式:content 留空 = 不改原有内容;改了才填新内容。</div>}
            </div>
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.modalFooter}>
              <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleSave}>{editing.isCreate ? '创建' : '保存'}</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 查看 content */}
      {viewing && (
        <Modal open title={`技能 · ${viewing.name}`} onClose={() => setViewing(null)} size="lg">
          <div className={styles.cardDesc}>{viewing.description}</div>
          <div className={styles.cardPrompt} style={{ marginTop: 8 }}>
            <MarkdownContent content={viewing.content} />
          </div>
        </Modal>
      )}

      {/* 从记忆沉淀 */}
      {promoteOpen && (
        <PromoteFromMemoryModal
          myAgentName={myAgentName}
          onClose={() => setPromoteOpen(false)}
          onDone={async () => { setPromoteOpen(false); await reload() }}
        />
      )}
    </div>
  )
}

function PromoteFromMemoryModal({ myAgentName, onClose, onDone }: {
  myAgentName: string
  onClose: () => void
  onDone: () => void
}) {
  const [playbooks, setPlaybooks] = useState<MemoryIndex[]>([])
  const [selected, setSelected] = useState<string>('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    memoryApi.listGlobal({ category: 'playbook' }).then(setPlaybooks).catch(e => setErr((e as Error).message))
  }, [])

  const submit = async () => {
    if (!selected) { setErr('选一条 playbook memory'); return }
    try {
      await skillsApi.promoteMemory(selected, { name: name || undefined, description: description || undefined, createdBy: myAgentName })
      onDone()
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <Modal open title="从 playbook 记忆沉淀为 skill" onClose={onClose} size="md">
      <div className={styles.form}>
        <div className={styles.note}>
          选一条 category=playbook 的全局记忆,其 value 作为 skill content,生成全局 skill。
          原 memory 保留。
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>选择 playbook memory</label>
          <Select value={selected} onChange={e => setSelected(e.target.value)} options={[
            { value: '', label: '— 选择 —' },
            ...playbooks.map(p => ({ value: p.id, label: `${p.key} — ${p.summary ?? ''}` })),
          ]} />
          {playbooks.length === 0 && <div className={styles.error}>没有全局 playbook 记忆。先 `rotom memory add --scope global --category playbook` 创建。</div>}
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>skill name (留空用 memory.key)</label>
          <Input value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>description (留空用 memory.summary)</label>
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        {err && <div className={styles.error}>{err}</div>}
        <div className={styles.modalFooter}>
          <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
          <Button variant="primary" size="sm" onClick={submit}>沉淀</Button>
        </div>
      </div>
    </Modal>
  )
}
