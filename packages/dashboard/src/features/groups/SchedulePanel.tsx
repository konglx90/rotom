import { useEffect, useState } from 'react'
import type { Schedule } from '../../api/types'
import { schedulesApi } from '../../api/schedules'
import styles from './SchedulePanel.module.css'

interface SchedulePanelProps {
  selectedGroupId: string
}

function formatTs(ms: number | null): string {
  if (ms === null || ms === undefined) return '-'
  try {
    return new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  } catch {
    return String(ms)
  }
}

function formatScheduleLabel(s: Schedule): string {
  if (s.schedule_kind === 'once') {
    return `once · ${formatTs(s.run_at)}`
  }
  const sec = s.interval_sec ?? 0
  if (sec >= 86400) return `every ${Math.floor(sec / 86400)}d`
  if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`
  if (sec >= 60) return `every ${Math.floor(sec / 60)}m`
  return `every ${sec}s`
}

export function SchedulePanel({ selectedGroupId }: SchedulePanelProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    if (!selectedGroupId) return
    setError(null)
    schedulesApi
      .listByGroup(selectedGroupId)
      .then(setSchedules)
      .catch(err => setError(err?.message ?? '加载失败'))
  }

  useEffect(() => {
    setSchedules([])
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

  // 每 30s 静默刷新一次,跟 master 调度器的 tick 频率对齐,看到 next_run_at / last_run_at 变化
  useEffect(() => {
    if (!selectedGroupId) return
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroupId])

  return (
    <div className={styles.schedulePanel}>
      {error ? (
        <div className={styles.scheduleEmpty}>{error}</div>
      ) : schedules.length === 0 ? (
        <div className={styles.scheduleEmpty}>
          暂无定时任务
          <div className={styles.scheduleHelp}>
            通过 CLI 创建: <code>rotom schedule add --group &lt;id&gt; --mode agent|message ...</code>
          </div>
        </div>
      ) : (
        <ul className={styles.scheduleList}>
          {schedules.map(s => (
            <ScheduleItem key={s.id} schedule={s} />
          ))}
        </ul>
      )}
    </div>
  )
}

const COLLAPSE_THRESHOLD = 200

/** 定时器人设名 —— 与后端 src/master/util/persona.ts 保持一致。不是 LLM,只是跑腿 scheduler。 */
const TIMER_PERSONA_NAME = '星期五'

/** ask-bridge 任务的展示信息:从 handler_payload 解析出 target/asker,渲染友好文案。 */
function parseAskBridgePayload(s: Schedule): { asker?: string; target?: string } | null {
  if (s.handler_key !== 'ask-bridge-check' || !s.handler_payload) return null
  try {
    const p = JSON.parse(s.handler_payload) as { asker?: string; target?: string }
    return { asker: p.asker, target: p.target }
  } catch {
    return null
  }
}

function ScheduleItem({ schedule: s }: { schedule: Schedule }) {
  const [expanded, setExpanded] = useState(false)
  const disabled = !s.enabled
  const lastClass =
    s.last_status === 'error'
      ? styles.error
      : s.last_status === 'skipped'
        ? styles.skipped
        : ''
  const canCollapse = s.prompt.length > COLLAPSE_THRESHOLD
  const bridge = parseAskBridgePayload(s)
  // ask-bridge 任务:name 已含"星期五 · 等待 X 回复",直接用;非 ask-bridge 任务:name 前贴人设 avatar
  const displayName = bridge?.target ? `等待 ${bridge.target} 回复` : s.name
  return (
    <li className={`${styles.scheduleItem} ${disabled ? styles.disabled : ''}`}>
      <div className={styles.scheduleItemHeader}>
        <span className={styles.schedulePersona} aria-label={TIMER_PERSONA_NAME}>
          🧑‍💼 <span className={styles.schedulePersonaName}>{TIMER_PERSONA_NAME}</span>
        </span>
        <span className={styles.scheduleName}>{displayName}</span>
        <span className={`${styles.scheduleBadge} ${s.mode === 'agent' ? styles.modeAgent : styles.modeMessage}`}>
          {s.mode}
        </span>
        {disabled && (
          <span className={`${styles.scheduleBadge} ${styles.disabled}`}>disabled</span>
        )}
      </div>
      <div className={styles.scheduleMeta}>
        <span className={styles.scheduleMetaItem}>{formatScheduleLabel(s)}</span>
        {s.schedule_kind === 'interval' && s.repeat_times !== null && (
          <span className={styles.scheduleMetaItem}>
            repeat {s.repeat_count}/{s.repeat_times}
          </span>
        )}
        {s.schedule_kind === 'interval' && s.repeat_times === null && (
          <span className={styles.scheduleMetaItem}>ran ×{s.repeat_count}</span>
        )}
        <span className={styles.scheduleMetaItem}>
          next: {formatTs(s.next_run_at)}
        </span>
      </div>
      <div
        className={`${styles.schedulePrompt} ${canCollapse && !expanded ? styles.schedulePromptCollapsed : ''}`}
      >
        {s.prompt}
      </div>
      {canCollapse && (
        <button
          type="button"
          className={styles.schedulePromptToggle}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
      {s.mode === 'agent' && (
        <div className={styles.scheduleMeta}>
          <span className={styles.scheduleMetaItem}>→ {s.agent_name ?? '(unset)'}</span>
        </div>
      )}
      {s.last_status && (
        <div className={`${styles.scheduleLastRun} ${lastClass}`}>
          last: {s.last_status}
          {s.last_status === 'error' && s.last_error ? ` · ${s.last_error}` : ''}
          {s.last_status === 'skipped' && s.last_error ? ` · ${s.last_error}` : ''}
          {' · '}{formatTs(s.last_run_at)}
        </div>
      )}
    </li>
  )
}