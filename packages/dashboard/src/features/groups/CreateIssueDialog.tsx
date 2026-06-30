import { useState } from 'react'
import type { Agent } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import { Modal } from '../../components/ui/Modal'
import styles from './GroupChatView.module.css'
import { truncateTitle } from './createIssueTitle'

interface CreateIssueDialogProps {
  open: boolean
  agents: Agent[]
  onClose: () => void
  onCreateIssue: (data: {
    description: string
    title?: string
    priority?: string
    assignedTo?: string
  }) => void
}

export function CreateIssueDialog({
  open,
  agents,
  onClose,
  onCreateIssue,
}: CreateIssueDialogProps) {
  // task form state —— 合并 title/description 后,用户只填一个内容字段。
  // title 由后端从 description 截断生成,这里只做实时预览。
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('medium')
  const [assignedTo, setAssignedTo] = useState('')

  const deliveryAgents = agents.filter(a => a.profile?.category !== '真人')

  const resetAll = () => {
    setDescription('')
    setPriority('medium')
    setAssignedTo('')
  }

  const handleClose = () => {
    resetAll()
    onClose()
  }

  // task submit —— 只发 description,title 由后端从 description 截断生成。
  // 若用户在内容里以 /plan 开头,后端 parseSlashCommand 会识别并进入计划模式。
  const handleTaskSubmit = () => {
    const trimmed = description.trim()
    if (!trimmed) return
    onCreateIssue({
      description: trimmed,
      priority: priority !== 'medium' ? priority : undefined,
      assignedTo: assignedTo || undefined,
    })
    handleClose()
  }

  const isTaskValid = !!description.trim()
  const titlePreview = truncateTitle(description)

  return (
    <Modal
      open={open}
      title="创建 Issue"
      scrollable={true}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={handleClose}>取消</Button>
          <Button variant="primary" size="md" onClick={handleTaskSubmit} disabled={!isTaskValid}>创建</Button>
        </div>
      }
    >
      <div className={styles.formField}>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          label="任务内容"
          placeholder='描述任务,或以 "/plan ..." 开头进入计划模式(标题会自动从内容前 40 字符生成)'
          rows={8} />
        {description.trim() && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-slate, #888)', padding: '4px 8px', background: 'var(--color-background, #f6f6f6)', borderRadius: 'var(--radius-sm, 4px)' }}>
            生成标题预览:<span style={{ fontFamily: 'var(--font-mono, monospace)', marginLeft: 6, color: 'var(--text-1, #333)' }}>{titlePreview}</span>
          </div>
        )}
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>优先级:</label>
        <select value={priority} onChange={e => setPriority(e.target.value)}
          className={styles.formSelect}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>指派 Agent (可选):</label>
        <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
          className={styles.formSelect}>
          <option value="">-- 暂不分配,稍后指派 --</option>
          {deliveryAgents.map(a => (
            <option key={a.id} value={a.name}>{a.name}</option>
          ))}
        </select>
      </div>
    </Modal>
  )
}
