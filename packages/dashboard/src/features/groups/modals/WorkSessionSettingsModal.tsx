import { Button } from '../../../components/ui/Button'
import { Checkbox } from '../../../components/ui/Checkbox'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { useWorkSession } from '../../../context/WorkSessionContext'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  onClose: () => void
}

export function WorkSessionSettingsModal({ open, onClose }: Props) {
  const {
    soundEnabled,
    soundVolume,
    breakIntervalMin,
    breakLengthMin,
    isOnBreak,
    setSoundEnabled,
    setSoundVolume,
    setBreakIntervalMin,
    setBreakLengthMin,
    playSound,
    resetSession,
    triggerBreakNow,
    endBreakEarly,
  } = useWorkSession()

  return (
    <Modal
      open={open}
      title="工作节奏与提醒"
      size="sm"
      onClose={onClose}
      footer={
        <div className={styles.modalActions}>
          <Button variant="primary" size="md" onClick={onClose}>完成</Button>
        </div>
      }
    >
      <div className={styles.formField}>
        <label className={styles.formLabel}>任务完成声音</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Checkbox
            checked={soundEnabled}
            onChange={setSoundEnabled}
            label="启用"
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={soundVolume}
            onChange={e => setSoundVolume(Number(e.target.value))}
            disabled={!soundEnabled}
            style={{ flex: 1 }}
            aria-label="音量"
          />
          <span style={{ fontSize: 12, color: 'var(--color-slate)', width: 36, textAlign: 'right' }}>
            {Math.round(soundVolume * 100)}%
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={playSound}
            disabled={!soundEnabled}
          >
            试听
          </Button>
        </div>
      </div>

      <div className={styles.formField}>
        <Input
          label="工作节奏(分钟)"
          type="number"
          min={1}
          max={180}
          size="sm"
          value={breakIntervalMin}
          onChange={e => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) setBreakIntervalMin(v)
          }}
          helperText="连续工作这么久后弹出休息提醒。"
        />
      </div>

      <div className={styles.formField}>
        <Input
          label="休息时长(分钟)"
          type="number"
          min={1}
          max={60}
          size="sm"
          value={breakLengthMin}
          onChange={e => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) setBreakLengthMin(v)
          }}
        />
      </div>

      <div className={styles.formField}>
        <label className={styles.formLabel}>快速操作</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={triggerBreakNow}
            disabled={isOnBreak}
          >
            ☕ 立刻开始休息
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={endBreakEarly}
            disabled={!isOnBreak}
          >
            ⚡ 立刻开始工作
          </Button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-slate)', marginTop: 4 }}>
          {isOnBreak
            ? '正在休息中。「立刻开始工作」会结束当前休息,重新计时工作节奏。'
            : `工作中。「立刻开始休息」会跳过剩余 ${breakIntervalMin} 分钟节奏中的等待,马上进入 ${breakLengthMin} 分钟休息。`}
        </div>
      </div>

      <div className={styles.formField}>
        <Button variant="ghost" size="sm" onClick={resetSession}>
          重置当前会话计时
        </Button>
        <div style={{ fontSize: 11, color: 'var(--color-slate)', marginTop: 4 }}>
          把工作时长清零,并重新开始本轮休息倒计时。偏好不会被清除。
        </div>
      </div>
    </Modal>
  )
}
