/**
 * Prompt管理 Tab —— 对 guidance_templates 表做完整 CRUD。
 * 列表 + 新建/编辑弹窗(name/description/prompt_text/schedule_config)。
 * 种子模板(is_default=1)不可删,删除按钮禁用。
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import { guidanceTemplatesApi } from '../../api/guidance-templates'
import type { GuidanceTemplate, GuidanceScheduleConfig } from '../../api/types'
import { ScheduleConfigEditor } from './ScheduleConfigEditor'
import styles from './ManagementTab.module.css'

interface EditState {
  id: number | null // null = 新建
  name: string
  description: string
  prompt_text: string
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
  prompt_text: '',
  schedule_config: null,
}

export function PromptsManagementTab() {
  const [templates, setTemplates] = useState<GuidanceTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setTemplates(await guidanceTemplatesApi.list())
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

  const openEdit = (t: GuidanceTemplate) => {
    setSaveError(null)
    setEdit({
      id: t.id,
      name: t.name,
      description: t.description,
      prompt_text: t.prompt_text,
      schedule_config: parseScheduleConfig(t.schedule_config),
    })
  }

  const handleSave = async () => {
    if (!edit) return
    if (!edit.name.trim()) { setSaveError('名称不能为空'); return }
    if (!edit.prompt_text.trim()) { setSaveError('prompt_text 不能为空'); return }
    setSaving(true)
    setSaveError(null)
    try {
      const scheduleConfig = edit.schedule_config ? JSON.stringify(edit.schedule_config) : null
      if (edit.id === null) {
        await guidanceTemplatesApi.create({
          name: edit.name.trim(),
          description: edit.description,
          prompt_text: edit.prompt_text,
          schedule_config: scheduleConfig,
        })
      } else {
        await guidanceTemplatesApi.update(edit.id, {
          name: edit.name.trim(),
          description: edit.description,
          prompt_text: edit.prompt_text,
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

  const handleDelete = async (t: GuidanceTemplate) => {
    if (t.is_default === 1) return
    if (!confirm(`确认删除模板「${t.name}」?`)) return
    try {
      await guidanceTemplatesApi.remove(t.id)
      await load()
    } catch (e: any) {
      alert(`删除失败: ${e?.message ?? String(e)}`)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>群指导 Prompt 模板</h2>
          <p className={styles.subheading}>
            管理可复用的群指导 prompt 模板。选模板建群时,prompt 与调度配置会一并应用。
            种子模板不可删除。
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openCreate}>+ 新建模板</Button>
      </div>

      {loading && <div className={styles.empty}>加载中...</div>}
      {error && <div className={styles.error}>{error}</div>}
      {!loading && !error && templates.length === 0 && (
        <div className={styles.empty}>暂无模板,点「+ 新建模板」创建。</div>
      )}

      <div className={styles.list}>
        {templates.map(t => {
          const cfg = parseScheduleConfig(t.schedule_config)
          return (
            <div key={t.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardName}>{t.name}</span>
                {t.is_default === 1 && <span className={styles.badgeDefault}>种子</span>}
                {cfg && <span className={styles.badgeSchedule}>·带定时任务</span>}
              </div>
              {t.description && <div className={styles.cardDesc}>{t.description}</div>}
              <div className={styles.cardPrompt}>{t.prompt_text}</div>
              {cfg && (
                <div className={styles.cardSchedule}>
                  {cfg.schedule_kind === 'interval'
                    ? `每 ${cfg.interval_sec}s` + (cfg.repeat_times ? ` · 重复 ${cfg.repeat_times} 次` : ' · 无限')
                    : `once · ${cfg.run_at ?? 0}`}{cfg.mode === 'agent' && cfg.agent_name ? ` · agent: ${cfg.agent_name}` : ''}
                </div>
              )}
              <div className={styles.cardActions}>
                <Button variant="ghost" size="xs" onClick={() => openEdit(t)}>编辑</Button>
                <Button
                  variant="danger"
                  size="xs"
                  outline
                  disabled={t.is_default === 1}
                  onClick={() => handleDelete(t)}
                  title={t.is_default === 1 ? '种子模板不可删除' : '删除'}
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
        title={edit?.id === null ? '新建 Prompt 模板' : '编辑 Prompt 模板'}
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
              <Input
                type="text"
                value={edit.name}
                onChange={e => setEdit({ ...edit, name: e.target.value })}
                placeholder="模板名称"
              />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>描述</label>
              <Input
                type="text"
                value={edit.description}
                onChange={e => setEdit({ ...edit, description: e.target.value })}
                placeholder="一句话说明用途"
              />
            </div>
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>prompt_text</label>
              <MarkdownEditor
                value={edit.prompt_text}
                onChange={v => setEdit({ ...edit, prompt_text: v })}
                rows={8}
                placeholder="支持 {{teacher}}/{{student}}/{{topic}} 占位符"
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
