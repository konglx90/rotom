import { useState } from 'react'
import type { Agent } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  agents: Agent[]
  myAgentName: string
  onClose: () => void
  onCreate: (name: string, memberNames: string[], workingDir?: string) => Promise<void> | void
}

export function CreateGroupModal({ open, agents, myAgentName, onClose, onCreate }: Props) {
  const [groupName, setGroupName] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const handleClose = () => {
    setGroupName('')
    setWorkingDir('')
    setSelectedMembers([])
    onClose()
  }

  const handleCreate = async () => {
    if (!groupName.trim() || submitting) return
    setSubmitting(true)
    try {
      await onCreate(groupName.trim(), selectedMembers, workingDir.trim() || undefined)
      // Success: clear inputs (parent will close the modal on its own).
      setGroupName('')
      setWorkingDir('')
      setSelectedMembers([])
    } catch {
      // Parent already surfaced the error (e.g. via alert). Keep inputs so the
      // user can fix the working directory and retry.
    } finally {
      setSubmitting(false)
    }
  }

  const otherAgents = agents.filter(a => a.name !== myAgentName)

  return (
    <Modal open={open} title="创建群">
      <div className={styles.formField}>
        <label className={styles.formLabel}>群名称:</label>
        <input type="text" value={groupName} onChange={e => setGroupName(e.target.value)}
          placeholder="输入群名称" className={styles.formInput} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>工作目录（可选）:</label>
        <input type="text" value={workingDir} onChange={e => setWorkingDir(e.target.value)}
          placeholder="例如: /Users/me/code/my-repo 或 ~/code/my-repo" className={styles.formInput} />
        <p style={{ fontSize: 11, color: 'var(--color-slate)', margin: '6px 2px 0' }}>
          支持 ~/ 自动展开。必须是已存在的目录；不填则默认使用 ~/.rotom/results/&lt;群id&gt;（自动创建）。
        </p>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>选择成员:</label>
        <div className={styles.agentCheckList}>
          {otherAgents.map(agent => (
            <label key={agent.id} className={styles.agentCheckItem}>
              <input type="checkbox" checked={selectedMembers.includes(agent.name)}
                onChange={e => {
                  if (e.target.checked) setSelectedMembers(prev => [...prev, agent.name])
                  else setSelectedMembers(prev => prev.filter(n => n !== agent.name))
                }} />
              {agent.name}
              <span className={`${styles.agentCheckStatus} ${agent.status === 'online' ? styles.online : styles.offline}`}>
                {agent.status === 'online' ? '在线' : '离线'}
              </span>
            </label>
          ))}
          {otherAgents.length === 0 && (
            <div style={{ padding: 16, color: 'var(--color-slate)', textAlign: 'center', fontSize: 13 }}>
              暂无其他 Agent
            </div>
          )}
        </div>
      </div>
      <div className={styles.modalActions}>
        <Button variant="secondary" size="md" onClick={handleClose} disabled={submitting}>取消</Button>
        <Button variant="primary" size="md" onClick={handleCreate} disabled={!groupName.trim() || submitting}>
          {submitting ? '创建中...' : '创建'}
        </Button>
      </div>
    </Modal>
  )
}
