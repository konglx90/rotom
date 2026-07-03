import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../../components/ui/Modal/Modal'
import { Input } from '../../../components/ui/Input'
import { guidanceTemplatesApi } from '../../../api/guidance-templates'
import { schedulesApi } from '../../../api/schedules'
import type { GuidanceTemplate, GuidanceScheduleConfig } from '../../../api/types'
import { extractPlaceholders, resolvePlaceholders } from '../utils/resolvePlaceholders'

interface Props {
  open: boolean
  /**
   * 'apply' (默认): 解析后立即回填 prompt + 自动创建定时任务(需 groupId/groupName)。
   * 'select': 仅解析,通过 onResolved 回传 resolvedPrompt + scheduleConfig,不创建定时任务。
   *          用于建群前选模板 —— 群 id 还不存在,等建群后再落地。
   */
  mode?: 'apply' | 'select'
  /** apply 模式必填。 */
  groupId?: string
  /** apply 模式必填。 */
  groupName?: string
  /** 群内成员 agent 名,用于默认填 {{teacher}}/{{student}}。 */
  memberAgentNames: string[]
  /** apply 模式:模板解析后,把 prompt 文本回填到 textarea。 */
  onPromptApplied?: (resolvedPrompt: string) => void
  /** apply 模式:创建了定时任务后通知父组件刷新 SchedulePanel。 */
  onScheduleCreated?: () => void
  /** select 模式:回传解析后的 prompt 和 schedule 配置(无则 null)。 */
  onResolved?: (resolvedPrompt: string, scheduleConfig: GuidanceScheduleConfig | null, templateName: string) => void
  onClose: () => void
}

const PLACEHOLDER_LABELS: Record<string, string> = {
  teacher: '老师 agent',
  student: '学生 agent',
  topic: '讨论话题',
}

/**
 * 群指导模板选择器。
 * apply 模式:列表 → 选中 → 填占位符 → 确认 → 回填 prompt + 建定时任务
 * select 模式:列表 → 选中 → 填占位符 → 确认 → onResolved 回传,不落地
 */
export function GuidanceTemplatePicker({
  open,
  mode = 'apply',
  groupId,
  groupName,
  memberAgentNames,
  onPromptApplied,
  onScheduleCreated,
  onResolved,
  onClose,
}: Props) {
  const [templates, setTemplates] = useState<GuidanceTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GuidanceTemplate | null>(null)
  const [vars, setVars] = useState<Record<string, string>>({})
  const [applying, setApplying] = useState(false)
  const [applyMsg, setApplyMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setApplyMsg(null)
    setSelected(null)
    guidanceTemplatesApi
      .list()
      .then(setTemplates)
      .catch(err => setError(err?.message ?? '加载失败'))
      .finally(() => setLoading(false))
  }, [open])

  /** 选中模板后,扫描占位符并预填默认值。 */
  const pickTemplate = (tpl: GuidanceTemplate) => {
    setSelected(tpl)
    setApplyMsg(null)
    const combined = tpl.prompt_text + (tpl.schedule_config ?? '')
    const keys = extractPlaceholders(combined)
    const defaults: Record<string, string> = {}
    keys.forEach((k) => {
      if (k === 'teacher' && memberAgentNames[0]) defaults[k] = memberAgentNames[0]
      else if (k === 'student' && memberAgentNames[1]) defaults[k] = memberAgentNames[1]
      else defaults[k] = ''
    })
    setVars(defaults)
  }

  const placeholders = useMemo(() => {
    if (!selected) return []
    const combined = selected.prompt_text + (selected.schedule_config ?? '')
    return extractPlaceholders(combined)
  }, [selected])

  const apply = async () => {
    if (!selected) return
    setApplying(true)
    setApplyMsg(null)
    try {
      const resolvedPrompt = resolvePlaceholders(selected.prompt_text, vars)

      let resolvedCfg: GuidanceScheduleConfig | null = null
      if (selected.schedule_config) {
        const cfg = JSON.parse(selected.schedule_config) as GuidanceScheduleConfig
        resolvedCfg = {
          ...cfg,
          agent_name: cfg.agent_name ? resolvePlaceholders(cfg.agent_name, vars) : undefined,
          prompt: resolvePlaceholders(cfg.prompt, vars),
        }
      }

      if (mode === 'select') {
        onResolved?.(resolvedPrompt, resolvedCfg, selected.name)
        onClose()
        return
      }

      // apply 模式:回填 + 立即建定时任务
      onPromptApplied?.(resolvedPrompt)

      if (resolvedCfg && groupId) {
        const name = `${selected.name}-${groupName ?? ''}-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        const created = await schedulesApi.create({
          name,
          group_id: groupId,
          mode: resolvedCfg.mode,
          agent_name: resolvedCfg.agent_name,
          schedule_kind: resolvedCfg.schedule_kind,
          interval_sec: resolvedCfg.interval_sec,
          run_at: resolvedCfg.run_at,
          prompt: resolvedCfg.prompt,
          repeat_times: resolvedCfg.repeat_times ?? null,
          enabled: true,
        })
        setApplyMsg(`已应用模板,并创建定时任务 #${created.id} (${resolvedCfg.schedule_kind === 'interval' ? `每 ${resolvedCfg.interval_sec}s` : 'once'},重复 ${resolvedCfg.repeat_times ?? '∞'} 次)`)
        onScheduleCreated?.()
      } else {
        setApplyMsg('已应用模板到群指导 prompt,记得点「保存」生效。')
      }
      onClose()
    } catch (err: any) {
      setApplyMsg(`应用失败: ${err?.message ?? String(err)}`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal open={open} title="选择群指导模板" onClose={onClose} size="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
        {loading && <div style={{ fontSize: 13, color: 'var(--color-slate)' }}>加载中...</div>}
        {error && <div style={{ fontSize: 13, color: 'rgb(220,38,38)' }}>{error}</div>}
        {!loading && !error && !selected && (
          <>
            {templates.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--color-slate)' }}>暂无模板</div>
            )}
            {templates.map(tpl => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => pickTemplate(tpl)}
                style={{
                  textAlign: 'left',
                  border: '1px solid rgba(0,0,0,0.1)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  background: 'var(--color-surface, #fff)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-navy)' }}>
                  {tpl.name}
                  {tpl.schedule_config && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'rgb(99,102,241)' }}>·带定时任务</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-slate)', marginTop: 2 }}>{tpl.description}</div>
              </button>
            ))}
          </>
        )}

        {selected && (
          <>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-navy)' }}>
              {selected.name}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-slate)', background: 'rgba(0,0,0,0.03)', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap' }}>
              {selected.prompt_text}
            </div>
            {selected.schedule_config && (
              <div style={{ fontSize: 11, color: 'rgb(99,102,241)' }}>
                含定时任务配置,确认后会自动创建。
              </div>
            )}

            {placeholders.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <div style={{ fontSize: 12, color: 'var(--color-slate)' }}>填充占位符:</div>
                {placeholders.map(key => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span style={{ minWidth: 80, color: 'var(--color-navy)' }}>{PLACEHOLDER_LABELS[key] ?? key}</span>
                    <Input
                      type="text"
                      size="sm"
                      value={vars[key] ?? ''}
                      onChange={e => setVars(v => ({ ...v, [key]: e.target.value }))}
                      placeholder={`{{${key}}}`}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                  </label>
                ))}
              </div>
            )}

            {applyMsg && (
              <div style={{ fontSize: 12, color: applyMsg.startsWith('应用失败') ? 'rgb(220,38,38)' : 'rgb(22,163,74)' }}>
                {applyMsg}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setSelected(null)}
                disabled={applying}
                style={{
                  border: '1px solid rgba(0,0,0,0.12)',
                  background: 'transparent',
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                返回列表
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={applying}
                style={{
                  border: 'none',
                  background: 'var(--color-primary, #4f46e5)',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 12,
                  cursor: applying ? 'not-allowed' : 'pointer',
                  opacity: applying ? 0.6 : 1,
                }}
              >
                {applying ? '应用中...' : '应用模板'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
