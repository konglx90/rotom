import { useState } from 'react'
import { formatHMM, formatMMSS, useWorkSession } from '../../context/WorkSessionContext'
import { WorkSessionSettingsModal } from './modals/WorkSessionSettingsModal'
import styles from './GroupChatView.module.css'

const URGENT_MS = 10 * 60_000 // 距下次休息 ≤ 10min 视为紧迫,数字变橙

// modeSidebar(44px 竖列)内嵌的工作时间 widget。
// - 第一行:工作时长 H:MM(页面会话)
// - 第二行:下次休息倒计时 MM:SS,休息进行中显示剩余休息时长
// - 紧迫(≤10min)/进行中:卡片高亮,提示该歇了
// - 点击:打开 WorkSessionSettingsModal
export function ModeSidebarClock() {
  const {
    elapsedMs,
    msUntilBreak,
    isOnBreak,
    msUntilBreakEnd,
    breakLengthMin,
    postponeCount,
  } = useWorkSession()
  const [open, setOpen] = useState(false)

  const urgent = !isOnBreak && msUntilBreak > 0 && msUntilBreak <= URGENT_MS
  const overdue = !isOnBreak && msUntilBreak <= 0

  const className = [
    styles.modeClock,
    urgent ? styles.modeClockUrgent : '',
    overdue ? styles.modeClockOverdue : '',
    isOnBreak ? styles.modeClockBreak : '',
  ].filter(Boolean).join(' ')

  const title = isOnBreak
    ? `休息中 · 剩余 ${formatMMSS(msUntilBreakEnd)}(共 ${breakLengthMin}min)`
    : overdue
      ? `已连续工作 ${formatHMM(elapsedMs)},早该休息啦${postponeCount > 0 ? `(已推迟 ${postponeCount} 次)` : ''}`
      : `已工作 ${formatHMM(elapsedMs)} · 下次休息还有 ${formatMMSS(msUntilBreak)}${postponeCount > 0 ? `(已推迟 ${postponeCount} 次)` : ''} · 点击打开工作设置`

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
      >
        <span className={styles.modeClockRow}>
          <span className={styles.modeClockIcon}>⏱</span>
          <span className={styles.modeClockValue}>{formatHMM(elapsedMs)}</span>
        </span>
        <span className={styles.modeClockRow}>
          <span className={styles.modeClockIcon}>{isOnBreak ? '☕' : '🌿'}</span>
          <span className={styles.modeClockValue}>
            {isOnBreak ? formatMMSS(msUntilBreakEnd) : formatMMSS(msUntilBreak)}
          </span>
        </span>
      </button>
      <WorkSessionSettingsModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
