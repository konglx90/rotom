/**
 * 定时任务模板管理 Tab —— 调度模式参考库 (schedule_patterns 表) CRUD。
 * 定位:常见定时任务模式的参考/学习库,供配置群指导模板时引用,
 * 不直接管理群内生产任务(scheduled_tasks 实例)。
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import { schedulePatternsApi } from '../../api/schedule-patterns'
import type { SchedulePattern, GuidanceScheduleConfig } from '../../api/types'
import { ScheduleConfigEditor } from './ScheduleConfigEditor'
import styles from './ManagementTab.module.css'

interface EditState {
  id: number | null
  name: string
  description: string
  schedule_config: GuidanceScheduleConfig | null
}

function parseScheduleConfig(s: string | null): GuidanceScheduleConfig | null {
  if (!s) return null
  try { return JSON.parse(s) as GuidanceScheduleConfig } catch { return null }
}

const EMPTY_EDIT: EditState = {
  id: null,
  name: '',
  description: '',
  schedule_config: null,
}

export function SchedulePatternsTab() {
  const [patterns, setPatterns] = useState<SchedulePattern[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPatterns(await schedulePatternsApi.list())
    } catch (e: any) {
      setError(e?.message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setSaveError(null)
    setEdit({ ...EMPTY_EDIT })
  }

  const openEdit = (p: SchedulePattern) => {
    setSaveError(null)
    setEdit({
      id: p.id,
      name: p.name,
      description: p.description,
      schedule_config: parseScheduleConfig(p.schedule_config),
    })
  }

  const handleSave = async () => {
    if (!edit) return
    if (!edit.name.trim()) { setSaveError('名称不能为空'); return }
    setSaving(true)
    setSaveError(null)
    try {
      const scheduleConfig = edit.schedule_config ? JSON.stringify(edit.schedule_config) : null
      if (edit.id === null) {
        await schedulePatternsApi.create({
          name: edit.name.trim(),
          description: edit.description,
          schedule_config: scheduleConfig,
        })
      } else {
        await schedulePatternsApi.update(edit.id, {
          name: edit.name.trim(),
          description: edit.description,
          schedule_config: scheduleConfig,
        })
      }
      setEdit(null)
      await load()
    } catch (e: any) {
      setSaveError(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (p: SchedulePattern) => {
    if (p.is_default === 1) return
    if (!confirm(`确认删除模式「${p.name}」?`)) return
    try {
      await schedulePatternsApi.remove(p.id)
      await load()
    } catch (e: any) {
      alert(`删除失败: ${e?.message ?? String(e)}`)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>定时任务模板(调度模式参考库)</h2>
          <p className={styles.subheading}>
            常见定时任务模式的样板,供学习与引用。不直接管理群内生产任务。
            种子模式不可删除。
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openCreate}>+ 新建模式</Button>
      </div>

      <div className={styles.note}>
        💡 这是一个参考库,汇总常见调度模式。要为某个群实际创建定时任务,
        请到「对话 → 群设置 → 群指导 prompt → 📚 从模板选择」,或在 Prompt 管理
        里给模板配上调度配置后引用。
      </div>

      {loading && <div className={styles.empty}>加载中...</div>}
      {error && <div className={styles.error}>{error}</div>}
      {!loading && !error && patterns.length === 0 && (
        <div className={styles.empty}>暂无模式,点「+ 新建模式」创建。</div>
      )}

      <div className={styles.list}>
        {patterns.map(p => {
          const cfg = parseScheduleConfig(p.schedule_config)
          return (
            <div key={p.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardName}>{p.name}</span>
                {p.is_default === 1 && <span className={styles.badgeDefault}>种子</span>}
              </div>
              {p.description && <div className={styles.cardDesc}>{p.description}</div>}
              {cfg && (
                <>
                  <div className={styles.cardSchedule}>
                    {cfg.mode === 'agent' ? 'agent' : 'message'} · {' '}
                    {cfg.schedule_kind === 'interval'
                      ? `每 ${cfg.interval_sec}s` + (cfg.repeat_times ? ` · 重复 ${cfg.repeat_times} 次` : ' · 无限')
                      : `once · run_at ${cfg.run_at ?? 0}`}{cfg.mode === 'agent' && cfg.agent_name ? ` · agent: ${cfg.agent_name}` : ''}
                  </div>
                  {cfg.prompt && <div className={styles.cardPrompt}>{cfg.prompt}</div>}
                </>
              )}
              <div className={styles.cardActions}>
                <Button variant="ghost" size="xs" onClick={() => openEdit(p)}>编辑</Button>
                <Button
                  variant="danger"
                  size="xs"
                  outline
                  disabled={p.is_default === 1}
                  onClick={() => handleDelete(p)}
                  title={p.is_default === 1 ? '种子模式不可删除' : '删除'}
                >
                  删除
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      <Modal
        open={edit !== null}
        title={edit?.id === null ? '新建调度模式' : '编辑调度模式'}
        onClose={() => setEdit(null)}
        size="lg"
        footer={
          <div className={styles.modalFooter}>
            {saveError && <span className={styles.error}>{saveError}</span>}
            <Button variant="ghost" size="sm" onClick={() => setEdit(null)} disabled={saving}>取消</Button>
            <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>保存</Button>
          </div>
        }
      >
        {edit && (
          <div className={styles.form}>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>名称</label>
              <input
                type="text"
                className={styles.input}
                value={edit.name}
                onChange={e => setEdit({ ...edit, name: e.target.value })}
                placeholder="模式名称"
              />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>描述</label>
              <input
                type="text"
                className={styles.input}
                value={edit.description}
                onChange={e => setEdit({ ...edit, description: e.target.value })}
                placeholder="说明这个模式的适用场景"
              />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>调度配置</label>
              <ScheduleConfigEditor
                value={edit.schedule_config}
                onChange={v => setEdit({ ...edit, schedule_config: v })}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
