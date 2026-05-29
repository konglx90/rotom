import { useState } from 'react'
import type { Agent } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import { Modal } from '../../components/ui/Modal'
import styles from './GroupChatView.module.css'

interface CreateIssueModalProps {
  open: boolean
  agents: Agent[]
  onClose: () => void
  onSubmit: (data: {
    title: string
    description?: string
    priority?: string
    workingDir?: string
    assignedTo?: string
  }) => void
  defaultWorkingDir?: string
}

export function CreateIssueModal({ open, agents, onClose, onSubmit, defaultWorkingDir }: CreateIssueModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('medium')
  const [workingDir, setWorkingDir] = useState(defaultWorkingDir || '')
  const [assignedTo, setAssignedTo] = useState('')
  const [usePlanMode, setUsePlanMode] = useState(false)

  // 候选指派对象：所有非真人 agent（真人不参与抢单执行）
  const deliveryAgents = agents.filter(a => a.profile?.category !== '真人')

  const handleSubmit = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    // /plan 模式：master 端按 title 前缀解析白名单。复选框只负责给 title 拼前缀。
    const finalTitle = usePlanMode && !trimmed.startsWith('/plan') ? `/plan ${trimmed}` : trimmed
    onSubmit({
      title: finalTitle,
      description: description.trim() || undefined,
      priority: priority !== 'medium' ? priority : undefined,
      workingDir: workingDir.trim() || undefined,
      assignedTo: assignedTo || undefined,
    })
    setTitle('')
    setDescription('')
    setPriority('medium')
    setWorkingDir('')
    setAssignedTo('')
    setUsePlanMode(false)
  }

  return (
    <Modal
      open={open}
      title="创建 Issue"
      scrollable={true}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
          <Button variant="primary" size="md" onClick={handleSubmit} disabled={!title.trim()}>创建</Button>
        </div>
      }
    >
      <div className={styles.formField}>
        <label className={styles.formLabel}>标题:</label>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
          placeholder='描述任务，或以 "/plan ..." 开头进入计划模式' className={styles.formInput} />
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginTop: 10, fontSize: 13, color: 'var(--text-2, #666)', padding: '8px 10px', background: 'var(--color-background)', borderRadius: 'var(--radius-sm)' }}>
          <input type="checkbox" checked={usePlanMode} onChange={e => setUsePlanMode(e.target.checked)}
            style={{ marginTop: 2, accentColor: 'var(--color-info)' }} />
          <span style={{ flex: 1, lineHeight: 1.4 }}>
            <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, color: 'var(--color-info)' }}>/plan</span>
            <span style={{ marginLeft: 6 }}>计划模式（先输出方案，等待审批后再落盘；勾选自动添加 /plan 前缀）</span>
          </span>
        </label>
      </div>
      <div className={styles.formField}>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          label="详细描述"
          placeholder="任务的详细说明、预期结果等"
          rows={8} />
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
        <label className={styles.formLabel}>工作目录:</label>
        <input type="text" value={workingDir} onChange={e => setWorkingDir(e.target.value)}
          placeholder="例如: /path/to/project (留空使用默认)" className={styles.formInput} />
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
