/**
 * 共享的 schedule_config 编辑器。guidance_templates 和 schedule_patterns
 * 都用同一份 GuidanceScheduleConfig 结构(JSON 字符串存储),这里提供
 * 受控的字段编辑。value=null 表示「无调度」。
 */

import { useEffect, useState } from 'react'
import type { GuidanceScheduleConfig } from '../../api/types'
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
      <label className={styles.enableRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggleEnabled}
        />
        <span>带定时任务配置</span>
      </label>

      {enabled && (
        <div className={styles.fields}>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>模式</label>
            <select
              className={styles.select}
              value={cfg.mode}
              onChange={e => patch({ mode: e.target.value as 'agent' | 'message' })}
            >
              <option value="agent">agent (触发 agent 执行)</option>
              <option value="message">message (发送消息)</option>
            </select>
          </div>

          {cfg.mode === 'agent' && (
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>agent_name</label>
              <input
                type="text"
                className={styles.input}
                value={cfg.agent_name ?? ''}
                onChange={e => patch({ agent_name: e.target.value || undefined })}
                placeholder="agent 名,支持 {{teacher}} 等占位符"
              />
            </div>
          )}

          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>调度类型</label>
            <select
              className={styles.select}
              value={cfg.schedule_kind}
              onChange={e => patch({ schedule_kind: e.target.value as 'once' | 'interval' })}
            >
              <option value="interval">interval (周期)</option>
              <option value="once">once (单次)</option>
            </select>
          </div>

          {cfg.schedule_kind === 'interval' && (
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>interval_sec</label>
              <input
                type="number"
                min={30}
                className={styles.input}
                value={cfg.interval_sec ?? 60}
                onChange={e => patch({ interval_sec: Number(e.target.value) || undefined })}
              />
            </div>
          )}

          {cfg.schedule_kind === 'once' && (
            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel}>run_at (ms 时间戳)</label>
              <input
                type="number"
                className={styles.input}
                value={cfg.run_at ?? 0}
                onChange={e => patch({ run_at: Number(e.target.value) || undefined })}
                placeholder="0 = 立即"
              />
            </div>
          )}

          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>repeat_times</label>
            <input
              type="number"
              min={1}
              className={styles.input}
              value={cfg.repeat_times ?? ''}
              placeholder="留空 = 无限"
              onChange={e => {
                const v = e.target.value
                patch({ repeat_times: v === '' ? undefined : Number(v) })
              }}
            />
          </div>

          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>prompt</label>
            <textarea
              className={styles.textarea}
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
