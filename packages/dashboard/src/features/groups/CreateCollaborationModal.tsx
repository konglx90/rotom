import { useState, useEffect } from 'react'
import { api } from '../../api/client'
import type { Agent } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import styles from './GroupChatView.module.css'

interface CreateCollaborationModalProps {
  open: boolean
  agents: Agent[]
  groupMembers: string[]
  onClose: () => void
  onSubmit: (data: {
    title: string
    collaborationGoal: string
    participants: string[]
    maxRounds: number
    owner?: string
    createdBy: string
  }) => void
  createdBy: string
}

export function CreateCollaborationModal({ open, agents, groupMembers, onClose, onSubmit, createdBy }: CreateCollaborationModalProps) {
  const [title, setTitle] = useState('')
  const [collaborationGoal, setCollaborationGoal] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [firstSpeaker, setFirstSpeaker] = useState<string>('')
  const [maxRounds, setMaxRounds] = useState(3)
  const [owner, setOwner] = useState('')
  const [realPersons, setRealPersons] = useState<{name: string; id: string}[]>([])

  useEffect(() => {
    if (open) {
      api.get<{name: string; id: string}[]>('/real-persons').then(setRealPersons).catch(() => setRealPersons([]))
    }
  }, [open])

  // 第一位发言人若不在参与者列表中，自动回退到列表第一个
  useEffect(() => {
    if (firstSpeaker && !selectedParticipants.includes(firstSpeaker)) {
      setFirstSpeaker(selectedParticipants[0] || '')
    } else if (!firstSpeaker && selectedParticipants.length > 0) {
      setFirstSpeaker(selectedParticipants[0])
    }
  }, [selectedParticipants, firstSpeaker])

  const onlineAgents = agents.filter(a => a.status === 'online' && groupMembers.includes(a.name))

  const toggleParticipant = (name: string) => {
    setSelectedParticipants(prev =>
      prev.includes(name) ? prev.filter(p => p !== name) : [...prev, name]
    )
  }

  const handleSubmit = () => {
    if (!title.trim() || !collaborationGoal.trim() || selectedParticipants.length < 2) return
    // 把 firstSpeaker 排到 participants 第一位
    const speaker = firstSpeaker && selectedParticipants.includes(firstSpeaker)
      ? firstSpeaker
      : selectedParticipants[0]
    const participants = [speaker, ...selectedParticipants.filter(p => p !== speaker)]
    onSubmit({
      title: title.trim(),
      collaborationGoal: collaborationGoal.trim(),
      participants,
      maxRounds,
      owner: owner || undefined,
      createdBy,
    })
    setTitle('')
    setCollaborationGoal('')
    setSelectedParticipants([])
    setFirstSpeaker('')
    setMaxRounds(3)
    setOwner('')
  }

  return (
    <Modal
      open={open}
      title="创建协作任务"
      scrollable={true}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            size="md"
            onClick={handleSubmit}
            disabled={!title.trim() || !collaborationGoal.trim() || selectedParticipants.length < 2 || !firstSpeaker}
          >
            创建协作
          </Button>
        </div>
      }
    >
      <div className={styles.formField}>
        <label className={styles.formLabel}>标题:</label>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
          placeholder="协作任务标题" className={styles.formInput} />
      </div>
      <div className={styles.formField}>
        <MarkdownEditor
          value={collaborationGoal}
          onChange={setCollaborationGoal}
          label="协作目标"
          placeholder="描述需要协作完成的目标、背景和期望产出"
          rows={8} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>参与者 (至少2人):</label>
        <div style={{ maxHeight: 120, overflowY: 'auto', border: '1px solid var(--color-slate)', borderRadius: 'var(--radius-sm)', padding: 6, background: 'var(--color-surface)' }}>
          {onlineAgents.length === 0 && <div style={{ color: 'var(--color-slate)', padding: 8, textAlign: 'center', fontSize: 13 }}>暂无在线 Agent</div>}
          {onlineAgents.map(a => (
            <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', borderRadius: 'var(--radius-sm)', transition: 'background 0.15s' }}>
              <input
                type="checkbox"
                checked={selectedParticipants.includes(a.name)}
                onChange={() => toggleParticipant(a.name)}
                style={{ accentColor: 'var(--color-info)' }}
              />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</span>
              {a.profile?.category && <span style={{ color: 'var(--color-slate)', fontSize: 12, marginLeft: 'auto' }}>{a.profile.category}</span>}
            </label>
          ))}
        </div>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>第一位发言人:</label>
        <select
          value={firstSpeaker}
          onChange={e => setFirstSpeaker(e.target.value)}
          disabled={selectedParticipants.length === 0}
          className={styles.formSelect}>
          {selectedParticipants.length === 0 && <option value="">请先勾选参与者</option>}
          {selectedParticipants.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          协作启动后将由该成员先发言，并决定 @ 谁继续 / 何时结束
        </div>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>最大轮数:</label>
        <input type="number" value={maxRounds} onChange={e => setMaxRounds(Number(e.target.value) || 3)}
          min={1} max={20} className={styles.formInput} style={{ width: 80 }} />
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>负责人 (真人，可选):</label>
        <select value={owner} onChange={e => setOwner(e.target.value)} className={styles.formSelect}>
          <option value="">不指定</option>
          {realPersons.map(p => (
            <option key={p.id} value={p.name}>{p.name}</option>
          ))}
        </select>
      </div>
    </Modal>
  )
}
