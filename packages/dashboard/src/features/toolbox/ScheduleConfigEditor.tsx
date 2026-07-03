/**
 * 共享的 schedule_config 编辑器。guidance_templates 和 schedule_patterns
 * 都用同一份 GuidanceScheduleConfig 结构(JSON 字符串存储),这里提供
 * 受控的字段编辑。value=null 表示「无调度」。
 */

import { useEffect, useState } from 'react'
import type { GuidanceScheduleConfig } from '../../api/types'
import { Checkbox } from '../../components/ui/Checkbox'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import { Textarea } from '../../components/ui/Textarea'
import styles from './ScheduleConfigEditor.module.css'

interface Props {
  value: GuidanceScheduleConfig | null
  onChange: (v: GuidanceScheduleConfig | null) => void
}

const DEFAULT_CFG: GuidanceScheduleConfig = {
  mode: 'agent',
  schedule_kind: 'interval',
  interval_sec: 60,
  prompt: '',
}

export function ScheduleConfigEditor({ value, onChange }: Props) {
  const [enabled, setEnabled] = useState<boolean>(value !== null)

  useEffect(() => {
    setEnabled(value !== null)
  }, [value])

  const toggleEnabled = () => {
    if (enabled) {
      onChange(null)
      setEnabled(false)
    } else {
      onChange({ ...DEFAULT_CFG })
      setEnabled(true)
    }
  }

  const patch = (p: Partial<GuidanceScheduleConfig>) => {
    if (!value) return
    onChange({ ...value, ...p })
  }

  const cfg = value ?? DEFAULT_CFG

  return (
    <div className={styles.wrap}>
      <Checkbox
        checked={enabled}
        onChange={toggleEnabled}
        label="带定时任务配置"
      />

      {enabled && (
        <div className={styles.fields}>
          <div className={styles.fieldRow}>
            <Select
              label="模式"
              size="sm"
              value={cfg.mode}
              onChange={e => patch({ mode: e.target.value as 'agent' | 'message' })}
              options={[
                { value: 'agent', label: 'agent (触发 agent 执行)' },
                { value: 'message', label: 'message (发送消息)' },
              ]}
            />
          </div>

          {cfg.mode === 'agent' && (
            <div className={styles.fieldRow}>
              <Input
                label="agent_name"
                size="sm"
                value={cfg.agent_name ?? ''}
                onChange={e => patch({ agent_name: e.target.value || undefined })}
                placeholder="agent 名,支持 {{teacher}} 等占位符"
              />
            </div>
          )}

          <div className={styles.fieldRow}>
            <Select
              label="调度类型"
              size="sm"
              value={cfg.schedule_kind}
              onChange={e => patch({ schedule_kind: e.target.value as 'once' | 'interval' })}
              options={[
                { value: 'interval', label: 'interval (周期)' },
                { value: 'once', label: 'once (单次)' },
              ]}
            />
          </div>

          {cfg.schedule_kind === 'interval' && (
            <div className={styles.fieldRow}>
              <Input
                label="interval_sec"
                type="number"
                min={30}
                size="sm"
                value={cfg.interval_sec ?? 60}
                onChange={e => patch({ interval_sec: Number(e.target.value) || undefined })}
              />
            </div>
          )}

          {cfg.schedule_kind === 'once' && (
            <div className={styles.fieldRow}>
              <Input
                label="run_at (ms 时间戳)"
                type="number"
                size="sm"
                value={cfg.run_at ?? 0}
                onChange={e => patch({ run_at: Number(e.target.value) || undefined })}
                placeholder="0 = 立即"
              />
            </div>
          )}

          <div className={styles.fieldRow}>
            <Input
              label="repeat_times"
              type="number"
              min={1}
              size="sm"
              value={cfg.repeat_times ?? ''}
              placeholder="留空 = 无限"
              onChange={e => {
                const v = e.target.value
                patch({ repeat_times: v === '' ? undefined : Number(v) })
              }}
            />
          </div>

          <div className={styles.fieldRow}>
            <Textarea
              label="prompt"
              rows={4}
              value={cfg.prompt}
              onChange={e => patch({ prompt: e.target.value })}
              placeholder="定时任务触发时的 prompt,支持占位符"
            />
          </div>
        </div>
      )}
    </div>
  )
}
