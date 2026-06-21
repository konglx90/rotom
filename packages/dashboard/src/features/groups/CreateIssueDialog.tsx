import { useState, useEffect } from 'react'
import { api } from '../../api/client'
import type { Agent } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import { Modal } from '../../components/ui/Modal'
import styles from './GroupChatView.module.css'
import dialogStyles from './CreateIssueDialog.module.css'
import { truncateTitle } from './createIssueTitle'

interface CreateIssueDialogProps {
  open: boolean
  agents: Agent[]
  groupMembers: string[]
  myAgentName: string
  onClose: () => void
  onCreateIssue: (data: {
    description: string
    title?: string
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

  // task form state —— 合并 title/description 后,用户只填一个内容字段。
  // title 由后端从 description 截断生成,这里只做实时预览。
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('medium')
  const [assignedTo, setAssignedTo] = useState('')

  // collaboration form state
  const [collabTitle, setCollabTitle] = useState('')
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
    setDescription('')
    setPriority('medium')
    setAssignedTo('')
    setCollabTitle('')
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

  // collaboration submit
  const toggleParticipant = (name: string) => {
    setSelectedParticipants(prev =>
      prev.includes(name) ? prev.filter(p => p !== name) : [...prev, name]
    )
  }

  const handleCollabSubmit = () => {
    if (!collabTitle.trim() || !collabGoal.trim() || selectedParticipants.length < 2) return
    const speaker = firstSpeaker && selectedParticipants.includes(firstSpeaker)
      ? firstSpeaker
      : selectedParticipants[0]
    const participants = [speaker, ...selectedParticipants.filter(p => p !== speaker)]
    onCreateCollaboration({
      title: collabTitle.trim(),
      collaborationGoal: collabGoal.trim(),
      participants,
      maxRounds,
      owner: owner || undefined,
      createdBy: myAgentName,
    })
    handleClose()
  }

  const isTaskValid = !!description.trim()
  const isCollabValid = !!collabTitle.trim() && !!collabGoal.trim() && selectedParticipants.length >= 2 && !!firstSpeaker
  const titlePreview = truncateTitle(description)

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
        </>
      ) : (
        <>
          <div className={styles.formField}>
            <label className={styles.formLabel}>标题:</label>
            <input type="text" value={collabTitle} onChange={e => setCollabTitle(e.target.value)}
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
