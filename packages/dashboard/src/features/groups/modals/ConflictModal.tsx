import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  onCancel: () => void
  onTakeover: () => void
}

export function ConflictModal({ open, onCancel, onTakeover }: Props) {
  return (
    <Modal
      open={open}
      title="连接冲突"
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="md" onClick={onTakeover}>接管连接</Button>
        </div>
      }
    >
      <p style={{ color: 'var(--color-slate)', fontSize: 14, lineHeight: 1.6 }}>
        该 Agent 已在其他页面连接，接管后原页面的连接将断开。
      </p>
    </Modal>
  )
}
