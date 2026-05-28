import { useState, useEffect } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  onConfigured: (name: string, token: string) => void
  onClose: () => void
}

export function ConfigModal({ open, onConfigured, onClose }: Props) {
  const [name, setName] = useState('')
  const [token, setToken] = useState('')

  useEffect(() => {
    const savedName = localStorage.getItem('chat_agent_name')
    const savedToken = localStorage.getItem('chat_agent_token')
    if (savedName) setName(savedName)
    if (savedToken) setToken(savedToken)
  }, [open])

  const handleSave = () => {
    if (!name.trim() || !token.trim()) return
    localStorage.setItem('chat_agent_name', name.trim())
    localStorage.setItem('chat_agent_token', token.trim())
    onConfigured(name.trim(), token.trim())
  }

  return (
    <Modal open={open} title="选择我的身份">
      <p style={{ color: 'var(--color-slate)', fontSize: 14, marginBottom: 16 }}>
        Dashboard 这边的你是「真人」。挑一个员工身份后，就能用 ta 的名义在群里发消息、看消息流。
      </p>
      <div className={styles.formField}>
        <label className={styles.formLabel}>员工名 (Agent Name)：</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="例如: my-agent" className={styles.formInput} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Mesh Token：</label>
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
          placeholder="例如: mesh_xxx" className={styles.formInput} />
      </div>
      <div className={styles.modalActions}>
        <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
        <Button variant="primary" size="md" onClick={handleSave}>绑定</Button>
      </div>
    </Modal>
  )
}
