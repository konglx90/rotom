import { useState } from 'react'
import { Button } from '../../components/ui/Button'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import { Modal } from '../../components/ui/Modal'
import styles from './GroupChatView.module.css'

interface CreateNoteDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (data: { title: string; description?: string }) => void
}

export function CreateNoteDialog({ open, onClose, onCreate }: CreateNoteDialogProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const handleClose = () => {
    setTitle('')
    setDescription('')
    onClose()
  }

  const handleSubmit = () => {
    if (!title.trim()) return
    onCreate({ title: title.trim(), description: description.trim() || undefined })
    handleClose()
  }

  const isValid = !!title.trim()

  return (
    <Modal
      open={open}
      title="创建 Note"
      scrollable={true}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={handleClose}>取消</Button>
          <Button variant="primary" size="md" onClick={handleSubmit} disabled={!isValid}>创建</Button>
        </div>
      }
    >
      <div className={styles.formField}>
        <label className={styles.formLabel}>标题:</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="一句话概括这条记录"
          className={styles.formInput}
          autoFocus
        />
      </div>
      <div className={styles.formField}>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          label="内容 (Markdown)"
          placeholder="纯文字记录,会议纪要、想法、参考资料等"
          rows={12}
        />
      </div>
    </Modal>
  )
}
