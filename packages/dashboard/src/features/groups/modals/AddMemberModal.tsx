import { useState } from 'react'
import type { Agent } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  groupMemberNames: string[]
  agents: Agent[]
  onClose: () => void
  onAdd: (memberNames: string[]) => void
}

export function AddMemberModal({ open, groupMemberNames, agents, onClose, onAdd }: Props) {
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])

  const currentMemberNames = new Set(groupMemberNames)
  const availableAgents = agents.filter(a => !currentMemberNames.has(a.name))

  const handleClose = () => {
    setSelectedMembers([])
    onClose()
  }

  const handleAdd = () => {
    if (selectedMembers.length === 0) return
    onAdd(selectedMembers)
    setSelectedMembers([])
  }

  return (
    <Modal open={open} title="添加成员">
      {groupMemberNames.length > 0 && (
        <div className={styles.formField}>
          <label className={styles.formLabel}>当前成员:</label>
          <div className={styles.existingMemberList}>
            {groupMemberNames.map(name => {
              const agent = agents.find(a => a.name === name)
              return (
                <span key={name} className={styles.existingMemberTag}>
                  {name}
                  {agent && <span className={`${styles.agentCheckStatus} ${agent.status === 'online' ? styles.online : styles.offline}`}>
                    {agent.status === 'online' ? '在线' : '离线'}
                  </span>}
                </span>
              )
            })}
          </div>
        </div>
      )}
      <div className={styles.formField}>
        <label className={styles.formLabel}>选择要添加的 Agent:</label>
        <div className={styles.agentCheckList}>
          {availableAgents.map(agent => (
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
          {availableAgents.length === 0 && (
            <div style={{ padding: 16, color: 'var(--color-slate)', textAlign: 'center', fontSize: 13 }}>
              所有 Agent 都已在群中
            </div>
          )}
        </div>
      </div>
      <div className={styles.modalActions}>
        <Button variant="secondary" size="md" onClick={handleClose}>取消</Button>
        <Button variant="primary" size="md" onClick={handleAdd} disabled={selectedMembers.length === 0}>添加</Button>
      </div>
    </Modal>
  )
}
