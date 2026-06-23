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
  onCreate: (name: string, memberNames: string[], workingDir?: string, type?: string) => Promise<void> | void
}

export function CreateGroupModal({ open, agents, myAgentName, onClose, onCreate }: Props) {
  const [groupName, setGroupName] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [groupType, setGroupType] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const handleClose = () => {
    setGroupName('')
    setWorkingDir('')
    setGroupType('')
    setSelectedMembers([])
    onClose()
  }

  const handleCreate = async () => {
    if (!groupName.trim() || submitting) return
    setSubmitting(true)
    try {
      await onCreate(groupName.trim(), selectedMembers, workingDir.trim() || undefined, groupType || undefined)
      // Success: clear inputs (parent will close the modal on its own).
      setGroupName('')
      setWorkingDir('')
      setGroupType('')
      setSelectedMembers([])
    } catch {
      // Parent already surfaced the error (e.g. via alert). Keep inputs so the
      // user can fix the working directory and retry.
    } finally {
      setSubmitting(false)
    }
  }

  const otherAgents = agents.filter(a => a.name !== myAgentName)
  const isE2ed = groupType === 'e2ed'
  const maxMembers = isE2ed ? 2 : Infinity

  const toggleMember = (name: string) => {
    setSelectedMembers(prev => {
      if (prev.includes(name)) return prev.filter(n => n !== name)
      if (isE2ed && prev.length >= maxMembers) return prev
      return [...prev, name]
    })
  }

  return (
    <Modal
      open={open}
      title="创建群"
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={handleClose} disabled={submitting}>取消</Button>
          <Button variant="primary" size="md" onClick={handleCreate} disabled={!groupName.trim() || submitting}>
            {submitting ? '创建中...' : '创建'}
          </Button>
        </div>
      }
    >
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
          支持 ~/ 自动展开。必须是已存在的目录；不填则默认使用 ~/.rotom/artifacts/&lt;群id&gt;（自动创建）。
        </p>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>群类型:</label>
        <select value={groupType} onChange={e => setGroupType(e.target.value)} className={styles.formSelect}>
          <option value="">普通群</option>
          {/* <option value="e2ed">E2ED（端到端需求交付）</option> */}
        </select>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>
          选择成员:
          {isE2ed && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, color: 'var(--color-info)' }}>E2ED 模式限选 {maxMembers} 人</span>}
        </label>
        <div className={styles.agentCheckList}>
          {otherAgents.map(agent => {
            const checked = selectedMembers.includes(agent.name)
            const disabled = isE2ed && !checked && selectedMembers.length >= maxMembers
            return (
              <label key={agent.id} className={styles.agentCheckItem} style={disabled ? { opacity: 0.4 } : undefined}>
                <input type="checkbox" checked={checked} disabled={disabled}
                  onChange={() => toggleMember(agent.name)} />
                {agent.name}
                <span className={`${styles.agentCheckStatus} ${agent.status === 'online' ? styles.online : styles.offline}`}>
                  {agent.status === 'online' ? '在线' : '离线'}
                </span>
              </label>
            )
          })}
          {otherAgents.length === 0 && (
            <div style={{ padding: 16, color: 'var(--color-slate)', textAlign: 'center', fontSize: 13 }}>
              暂无其他 Agent
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
