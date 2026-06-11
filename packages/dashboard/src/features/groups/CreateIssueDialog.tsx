import { useState, useEffect } from 'react'
import { api } from '../../api/client'
import type { Agent } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import { Modal } from '../../components/ui/Modal'
import styles from './GroupChatView.module.css'
import dialogStyles from './CreateIssueDialog.module.css'

interface CreateIssueDialogProps {
  open: boolean
  agents: Agent[]
  groupMembers: string[]
  myAgentName: string
  onClose: () => void
  onCreateIssue: (data: {
    title: string
    description?: string
    priority?: string
    assignedTo?: string
  }) => void
  onCreateCollaboration: (data: {
    title: string
    collaborationGoal: string
    participants: string[]
    maxRounds: number
    owner?: string
    createdBy: string
  }) => void
}

type TabType = 'task' | 'collaboration'

export function CreateIssueDialog({
  open,
  agents,
  groupMembers,
  myAgentName,
  onClose,
  onCreateIssue,
  onCreateCollaboration,
}: CreateIssueDialogProps) {
  const [tab, setTab] = useState<TabType>('task')

  // task form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('medium')
  const [assignedTo, setAssignedTo] = useState('')
  const [usePlanMode, setUsePlanMode] = useState(false)

  // collaboration form state
  const [collabGoal, setCollabGoal] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [firstSpeaker, setFirstSpeaker] = useState<string>('')
  const [maxRounds, setMaxRounds] = useState(3)
  const [owner, setOwner] = useState('')
  const [realPersons, setRealPersons] = useState<{ name: string; id: string }[]>([])

  const deliveryAgents = agents.filter(a => a.profile?.category !== '真人')
  const onlineAgents = agents.filter(a => a.status === 'online' && groupMembers.includes(a.name))

  useEffect(() => {
    if (open) {
      api.get<{ name: string; id: string }[]>('/real-persons').then(setRealPersons).catch(() => setRealPersons([]))
    }
  }, [open])

  useEffect(() => {
    if (firstSpeaker && !selectedParticipants.includes(firstSpeaker)) {
      setFirstSpeaker(selectedParticipants[0] || '')
    } else if (!firstSpeaker && selectedParticipants.length > 0) {
      setFirstSpeaker(selectedParticipants[0])
    }
  }, [selectedParticipants, firstSpeaker])

  const resetAll = () => {
    setTitle('')
    setDescription('')
    setPriority('medium')
    setAssignedTo('')
    setUsePlanMode(false)
    setCollabGoal('')
    setSelectedParticipants([])
    setFirstSpeaker('')
    setMaxRounds(3)
    setOwner('')
  }

  const handleClose = () => {
    resetAll()
    onClose()
  }

  const handleTabChange = (t: TabType) => {
    setTab(t)
  }

  // task submit
  const handleTaskSubmit = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const finalTitle = usePlanMode && !trimmed.startsWith('/plan') ? `/plan ${trimmed}` : trimmed
    onCreateIssue({
      title: finalTitle,
      description: description.trim() || undefined,
      priority: priority !== 'medium' ? priority : undefined,
      assignedTo: assignedTo || undefined,
    })
    handleClose()
  }

  // collaboration submit
  const toggleParticipant = (name: string) => {
    setSelectedParticipants(prev =>
      prev.includes(name) ? prev.filter(p => p !== name) : [...prev, name]
    )
  }

  const handleCollabSubmit = () => {
    if (!title.trim() || !collabGoal.trim() || selectedParticipants.length < 2) return
    const speaker = firstSpeaker && selectedParticipants.includes(firstSpeaker)
      ? firstSpeaker
      : selectedParticipants[0]
    const participants = [speaker, ...selectedParticipants.filter(p => p !== speaker)]
    onCreateCollaboration({
      title: title.trim(),
      collaborationGoal: collabGoal.trim(),
      participants,
      maxRounds,
      owner: owner || undefined,
      createdBy: myAgentName,
    })
    handleClose()
  }

  const isTaskValid = !!title.trim()
  const isCollabValid = !!title.trim() && !!collabGoal.trim() && selectedParticipants.length >= 2 && !!firstSpeaker

  return (
    <Modal
      open={open}
      title="创建 Issue"
      scrollable={true}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={handleClose}>取消</Button>
          {tab === 'task' ? (
            <Button variant="primary" size="md" onClick={handleTaskSubmit} disabled={!isTaskValid}>创建</Button>
          ) : (
            <Button variant="primary" size="md" onClick={handleCollabSubmit} disabled={!isCollabValid}>创建协作</Button>
          )}
        </div>
      }
    >
      <div className={dialogStyles.tabBar}>
        <button
          className={`${dialogStyles.tab} ${tab === 'task' ? dialogStyles.tabActive : ''}`}
          onClick={() => handleTabChange('task')}
        >
          任务
        </button>
        <button
          className={`${dialogStyles.tab} ${tab === 'collaboration' ? dialogStyles.tabActive : ''}`}
          onClick={() => handleTabChange('collaboration')}
        >
          协作
        </button>
      </div>

      {tab === 'task' ? (
        <>
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
            <label className={styles.formLabel}>指派 Agent (可选):</label>
            <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
              className={styles.formSelect}>
              <option value="">-- 暂不分配,稍后指派 --</option>
              {deliveryAgents.map(a => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <>
          <div className={styles.formField}>
            <label className={styles.formLabel}>标题:</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              placeholder="协作任务标题" className={styles.formInput} />
          </div>
          <div className={styles.formField}>
            <MarkdownEditor
              value={collabGoal}
              onChange={setCollabGoal}
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
        </>
      )}
    </Modal>
  )
}
