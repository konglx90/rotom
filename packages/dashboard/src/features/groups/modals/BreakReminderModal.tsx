import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { formatHMM } from '../../../context/WorkSessionContext'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  elapsedMs: number
  breakLengthMin: number
  postponeCount: number
  onStartBreak: () => void
  onPostpone: () => void
}

export function BreakReminderModal({
  open,
  elapsedMs,
  breakLengthMin,
  postponeCount,
  onStartBreak,
  onPostpone,
}: Props) {
  return (
    <Modal
      open={open}
      title="该休息一下啦 🌿"
      size="sm"
      closeOnEsc={false}
      closeOnBackdrop={false}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={onPostpone}>
            推迟 5 分钟
          </Button>
          <Button variant="primary" size="md" onClick={onStartBreak}>
            开始 {breakLengthMin} 分钟休息
          </Button>
        </div>
      }
    >
      <p style={{ color: 'var(--color-ink)', fontSize: 14, lineHeight: 1.6, margin: 0 }}>
        你已经连续工作了 <strong>{formatHMM(elapsedMs)}</strong>。
        站起来走走、看远处,眼睛和肩膀会感谢你。
      </p>
      {postponeCount > 0 && (
        <p style={{ color: 'var(--color-warning)', fontSize: 12, marginTop: 12 }}>
          已推迟 {postponeCount} 次。长时间不休息容易疲劳,建议这次真的歇一下。
        </p>
      )}
    </Modal>
  )
}
