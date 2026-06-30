import { useState } from 'react'
import type { Agent, GuidanceScheduleConfig } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { GuidanceTemplatePicker } from './GuidanceTemplatePicker'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  agents: Agent[]
  myAgentName: string
  onClose: () => void
  onCreate: (
    name: string,
    memberNames: string[],
    workingDir?: string,
    type?: string,
    guidancePrompt?: string,
    scheduleConfig?: GuidanceScheduleConfig,
  ) => Promise<void> | void
}

export function CreateGroupModal({ open, agents, myAgentName, onClose, onCreate }: Props) {
  const [groupName, setGroupName] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [groupType, setGroupType] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [guidancePrompt, setGuidancePrompt] = useState<string | null>(null)
  const [scheduleConfig, setScheduleConfig] = useState<GuidanceScheduleConfig | null>(null)
  const [templateName, setTemplateName] = useState<string | null>(null)

  const handleClose = () => {
    setGroupName('')
    setWorkingDir('')
    setGroupType('')
    setSelectedMembers([])
    setGuidancePrompt(null)
    setScheduleConfig(null)
    setTemplateName(null)
    onClose()
  }

  const handleCreate = async () => {
    if (!groupName.trim() || submitting) return
    if (isPatrol && selectedMembers.length !== 1) {
      window.alert('巡检群必须且只能选 1 个 agent 作为巡检员')
      return
    }
    setSubmitting(true)
    try {
      await onCreate(
        groupName.trim(),
        selectedMembers,
        workingDir.trim() || undefined,
        groupType || undefined,
        guidancePrompt ?? undefined,
        scheduleConfig ?? undefined,
      )
      // Success: clear inputs (parent will close the modal on its own).
      setGroupName('')
      setWorkingDir('')
      setGroupType('')
      setSelectedMembers([])
      setGuidancePrompt(null)
      setScheduleConfig(null)
      setTemplateName(null)
    } catch {
      // Parent already surfaced the error (e.g. via alert). Keep inputs so the
      // user can fix the working directory and retry.
    } finally {
      setSubmitting(false)
    }
  }

  const otherAgents = agents.filter(a => a.name !== myAgentName)
  const isE2ed = groupType === 'e2ed'
  const isPatrol = groupType === 'patrol'
  const maxMembers = isPatrol ? 1 : (isE2ed ? 2 : Infinity)

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
        <select value={groupType} onChange={e => {
          const t = e.target.value
          setGroupType(t)
          if (t === 'patrol' && !groupName.trim()) {
            setGroupName('全局issue巡检群')
          }
        }} className={styles.formSelect}>
          <option value="">普通群</option>
          <option value="patrol">巡检群</option>
          {/* <option value="e2ed">E2ED（端到端需求交付）</option> */}
        </select>
        {isPatrol && (
          <p style={{ fontSize: 11, color: 'var(--color-info)', margin: '6px 2px 0' }}>
            巡检群全局限 1 个(归档/删除后才能再建),只选 1 个 agent 作为巡检员。
            建群后自动创建每小时巡检任务,可在工具箱「Issue 巡检」开关。
          </p>
        )}
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>
          选择成员:
          {isE2ed && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, color: 'var(--color-info)' }}>E2ED 模式限选 {maxMembers} 人</span>}
          {isPatrol && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, color: 'var(--color-info)' }}>巡检群限选 {maxMembers} 人(即巡检员)</span>}
        </label>
        <div className={styles.agentCheckList}>
          {otherAgents.map(agent => {
            const checked = selectedMembers.includes(agent.name)
            const disabled = (isE2ed || isPatrol) && !checked && selectedMembers.length >= maxMembers
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

      <div className={styles.formField}>
        <label className={styles.formLabel}>群指导模板（可选）:</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => setShowTemplatePicker(true)}
            style={{
              border: '1px solid rgba(0,0,0,0.12)',
              background: 'transparent',
              color: 'var(--color-navy)',
              borderRadius: 6,
              padding: '4px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            📚 从模板选择
          </button>
          {templateName && (
            <span style={{ fontSize: 12, color: 'var(--color-slate)' }}>
              已选: <strong style={{ color: 'var(--color-navy)' }}>{templateName}</strong>
              {scheduleConfig && <span style={{ marginLeft: 6, color: 'rgb(99,102,241)' }}>·带定时任务</span>}
            </span>
          )}
        </div>
        {guidancePrompt && (
          <div style={{ marginTop: 6, padding: 8, fontSize: 11, color: 'var(--color-slate)', background: 'rgba(0,0,0,0.03)', borderRadius: 6, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto' }}>
            {guidancePrompt}
          </div>
        )}
        <p style={{ fontSize: 11, color: 'var(--color-slate)', margin: '6px 2px 0' }}>
          建群时一并应用群指导 prompt;若模板含定时任务,建群后自动创建。
        </p>
      </div>

      {showTemplatePicker && (
        <GuidanceTemplatePicker
          open={showTemplatePicker}
          mode="select"
          memberAgentNames={selectedMembers}
          onResolved={(resolvedPrompt, resolvedCfg, tplName) => {
            setGuidancePrompt(resolvedPrompt)
            setScheduleConfig(resolvedCfg)
            setTemplateName(tplName)
            setShowTemplatePicker(false)
          }}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}
    </Modal>
  )
}
