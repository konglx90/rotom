import { useWorkSession, formatMMSS } from '../../context/WorkSessionContext'
import styles from './BreakOverlay.module.css'

const URGENT_MS = 10_000 // 最后 10 秒切到 waking 动画 + 数字脉冲

// vite base 是 /dashboard/,public 资源必须带前缀。用 BASE_URL 自适应 dev/build。
const ANIM = `${import.meta.env.BASE_URL}animations/`

// 左下角休息伴侣卡片。breakInProgress 时由 WorkSessionProvider 渲染。
// 小尺寸,不挡主区;倒计时最后 10 秒切到 waking 动画 + 数字脉冲。
export function BreakOverlay() {
  const { isOnBreak, msUntilBreakEnd, endBreakEarly } = useWorkSession()

  if (!isOnBreak) return null

  const urgent = msUntilBreakEnd <= URGENT_MS
  const sprite = urgent ? `${ANIM}calico-waking.apng` : `${ANIM}calico-sleeping.apng`
  const spriteAlt = urgent ? '快要醒了的小猫' : '正在睡觉的小猫'

  return (
    <div className={styles.overlay} role="status" aria-label={`休息中,剩余 ${formatMMSS(msUntilBreakEnd)}`}>
      <img className={styles.sprite} src={sprite} alt={spriteAlt} />
      <div className={styles.label}>休息中</div>
      <div className={`${styles.timer} ${urgent ? styles.timerUrgent : ''}`}>
        {formatMMSS(msUntilBreakEnd)}
      </div>
      <button type="button" className={styles.endBtn} onClick={endBreakEarly}>
        ⚡ 开始工作
      </button>
    </div>
  )
}
