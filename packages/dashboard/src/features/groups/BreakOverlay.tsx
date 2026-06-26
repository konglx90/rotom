import { useWorkSession, formatMMSS } from '../../context/WorkSessionContext'
import styles from './BreakOverlay.module.css'

const URGENT_MS = 10_000 // 最后 10 秒切到 waking 动画 + 数字脉冲

// 全屏休息覆盖层。breakInProgress 时由 WorkSessionProvider 渲染。
// 用户休息时常不戴眼镜:大动画 + 巨大倒计时 + 高对比暖色调,
// 远距离也能看清剩余时间和「立刻开始工作」按钮。
export function BreakOverlay() {
  const { isOnBreak, msUntilBreakEnd, breakLengthMin, endBreakEarly, postponeBreak } = useWorkSession()

  if (!isOnBreak) return null

  const urgent = msUntilBreakEnd <= URGENT_MS
  const sprite = urgent ? '/animations/calico-waking.apng' : '/animations/calico-sleeping.apng'
  const spriteAlt = urgent ? '快要醒了的小猫动画' : '正在睡觉的小猫动画'

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="休息中">
      <div className={styles.content}>
        <img className={styles.sprite} src={sprite} alt={spriteAlt} />
        <div className={styles.label}>休息中 · 闭上眼,或者站起来走走</div>
        <div className={`${styles.timer} ${urgent ? styles.timerUrgent : ''}`}>
          {formatMMSS(msUntilBreakEnd)}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.endBtn} onClick={endBreakEarly}>
            ⚡ 立刻开始工作
          </button>
          <button type="button" className={styles.postpone} onClick={() => postponeBreak(1)}>
            再歇 1 分钟
          </button>
        </div>
        <p className={styles.tip}>
          本次休息共 {breakLengthMin} 分钟。到时间会自动返回工作状态,并播放提示音。
        </p>
      </div>
    </div>
  )
}
