import { useState, useEffect } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  onConfigured: (name: string, token: string) => void
}

export function ConfigModal({ open, onConfigured }: Props) {
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

  const handleCancel = () => {
    const savedName = localStorage.getItem('chat_agent_name')
    const savedToken = localStorage.getItem('chat_agent_token')
    if (savedName && savedToken) {
      onConfigured(savedName, savedToken)
    }
  }

  return (
    <Modal open={open} title="配置你的 Agent">
      <p style={{ color: 'var(--color-slate)', fontSize: 14, marginBottom: 16 }}>
        请输入 Agent 配置信息以连接到 Master 并使用群消息功能。
      </p>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Agent Name:</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="例如: my-agent" className={styles.formInput} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>Agent Token:</label>
        <input type="password" value={token} onChange={e => setToken(e.target.value)}
          placeholder="例如: mesh_xxx" className={styles.formInput} />
      </div>
      <div className={styles.modalActions}>
        <Button variant="secondary" size="md" onClick={handleCancel}>取消</Button>
        <Button variant="primary" size="md" onClick={handleSave}>连接</Button>
      </div>
    </Modal>
  )
}
