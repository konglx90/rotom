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
    repoConfig?: { repoUrl: string | null; repoDefaultBranch: string | null; extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode: 'group' | 'issue' | null },
  ) => Promise<void> | void
}

export function CreateGroupModal({ open, agents, myAgentName, onClose, onCreate }: Props) {
  const [groupName, setGroupName] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [groupType, setGroupType] = useState('')
  // 聊天形态:'group'=群聊(默认,'normal'/'patrol' 走原逻辑);'direct'=单聊(2 人,type=direct)
  const [chatKind, setChatKind] = useState<'group' | 'direct'>('group')
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [guidancePrompt, setGuidancePrompt] = useState<string | null>(null)
  const [scheduleConfig, setScheduleConfig] = useState<GuidanceScheduleConfig | null>(null)
  const [templateName, setTemplateName] = useState<string | null>(null)
  // repo 配置(可选):留空 repoUrl 则不启用 worktree 模式
  const [repoUrl, setRepoUrl] = useState('')
  const [repoDefaultBranch, setRepoDefaultBranch] = useState('')
  const [extraRepos, setExtraRepos] = useState<Array<{ id: string; url: string; branch: string }>>([{ id: '', url: '', branch: '' }])
  const [worktreeMode, setWorktreeMode] = useState<'group' | 'issue'>('group')

  const handleClose = () => {
    setGroupName('')
    setWorkingDir('')
    setGroupType('')
    setChatKind('group')
    setSelectedMembers([])
    setGuidancePrompt(null)
    setScheduleConfig(null)
    setTemplateName(null)
    setRepoUrl('')
    setRepoDefaultBranch('')
    setExtraRepos([{ id: '', url: '', branch: '' }])
    setWorktreeMode('group')
    onClose()
  }

  const updateExtra = (idx: number, field: 'id' | 'url' | 'branch', value: string) => {
    setExtraRepos(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e))
  }
  const addExtra = () => setExtraRepos(prev => [...prev, { id: '', url: '', branch: '' }])
  const removeExtra = (idx: number) => setExtraRepos(prev => prev.filter((_, i) => i !== idx))

  const handleCreate = async () => {
    if (!groupName.trim() || submitting) return
    if (isPatrol && selectedMembers.length !== 1) {
      window.alert('巡检群必须且只能选 1 个 agent 作为巡检员')
      return
    }
    if (isDirect && selectedMembers.length !== 1) {
      window.alert('单聊必须且只能选 1 个 agent')
      return
    }
    // 解析 extraRepos:过滤掉空行,mountPath 自动 = repos/<id>
    let extraParsed: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null = null
    const filled = extraRepos.filter(e => e.id.trim() && e.url.trim())
    if (filled.length > 0) {
      extraParsed = filled.map(e => ({
        id: e.id.trim(),
        url: e.url.trim(),
        branch: e.branch.trim() || undefined,
        mountPath: `__repos/${e.id.trim()}`,
      }))
    }
    const repoConfig = (repoUrl.trim() || extraParsed)
      ? {
          repoUrl: repoUrl.trim() || null,
          repoDefaultBranch: repoDefaultBranch.trim() || null,
          extraRepos: extraParsed,
          worktreeMode,
        }
      : undefined
    setSubmitting(true)
    try {
      const submitType = isDirect ? 'direct' : groupType || undefined
      await onCreate(
        groupName.trim(),
        selectedMembers,
        workingDir.trim() || undefined,
        submitType,
        guidancePrompt ?? undefined,
        scheduleConfig ?? undefined,
        repoConfig,
      )
      // Success: clear inputs (parent will close the modal on its own).
      setGroupName('')
      setWorkingDir('')
      setGroupType('')
      setChatKind('group')
      setSelectedMembers([])
      setGuidancePrompt(null)
      setScheduleConfig(null)
      setTemplateName(null)
      setRepoUrl('')
      setRepoDefaultBranch('')
      setExtraRepos([{ id: '', url: '', branch: '' }])
      setWorktreeMode('group')
    } catch {
      // Parent already surfaced the error (e.g. via alert). Keep inputs so the
      // user can fix the working directory and retry.
    } finally {
      setSubmitting(false)
    }
  }

  const otherAgents = agents.filter(a => a.name !== myAgentName)
  const isPatrol = chatKind === 'group' && groupType === 'patrol'
  const isDirect = chatKind === 'direct'
  // 单聊限选 1 人(自己 + 1 = 2 人对话);巡检群也限 1 人;其他不限。
  const maxMembers = (isDirect || isPatrol) ? 1 : Infinity

  const toggleMember = (name: string) => {
    setSelectedMembers(prev => {
      if (prev.includes(name)) return prev.filter(n => n !== name)
      return [...prev, name]
    })
  }

  // 切换聊天形态时:清空已选成员 + 调整默认名称。
  // 单聊默认名称"我和 <agent>";切回群聊若名称是单聊默认值则清空让用户重填。
  const handleChatKindChange = (kind: 'group' | 'direct') => {
    if (kind === chatKind) return
    setSelectedMembers([])
    if (kind === 'direct') {
      setGroupName('')
    } else if (groupName.startsWith('我和 ')) {
      setGroupName('')
    }
    setChatKind(kind)
  }

  // 单聊模式:点 agent 立即创建并跳转,不走表单提交(类似「一对一」里 + 按钮的体验)。
  // 群聊模式:正常 toggle checkbox,等用户点 footer 的"创建"。
  const handleToggleMember = async (name: string) => {
    if (isDirect) {
      if (submitting) return
      setSubmitting(true)
      try {
        await onCreate(name, [name], undefined, 'direct', undefined, undefined, undefined)
        handleClose()
      } catch {
        // 父组件已 alert 错误;留在 modal 上让用户重选。
      } finally {
        setSubmitting(false)
      }
      return
    }
    toggleMember(name)
  }

  return (
    <Modal
      open={open}
      title={isDirect ? '发起单聊' : '创建对话'}
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={handleClose} disabled={submitting}>取消</Button>
          {!isDirect && (
            <Button variant="primary" size="md" onClick={handleCreate} disabled={!groupName.trim() || submitting}>
              {submitting ? '创建中...' : '创建'}
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.formField}>
        <label className={styles.formLabel}>聊天类型:</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => handleChatKindChange('group')}
            style={{
              flex: 1, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
              borderRadius: 6, border: `1px solid ${chatKind === 'group' ? 'var(--color-wise-green, #9fe870)' : 'var(--border-color-light, #ddd)'}`,
              background: chatKind === 'group' ? 'rgba(159, 232, 112, 0.18)' : 'transparent',
              fontWeight: chatKind === 'group' ? 700 : 500,
              color: chatKind === 'group' ? 'var(--color-dark-green, #1f4d1a)' : 'inherit',
            }}>
            💬 群聊(多人)
          </button>
          <button type="button" onClick={() => handleChatKindChange('direct')}
            style={{
              flex: 1, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
              borderRadius: 6, border: `1px solid ${chatKind === 'direct' ? 'var(--color-wise-green, #9fe870)' : 'var(--border-color-light, #ddd)'}`,
              background: chatKind === 'direct' ? 'rgba(159, 232, 112, 0.18)' : 'transparent',
              fontWeight: chatKind === 'direct' ? 700 : 500,
              color: chatKind === 'direct' ? 'var(--color-dark-green, #1f4d1a)' : 'inherit',
            }}>
            👤 单聊(1 对 1)
          </button>
        </div>
        {isDirect && (
          <p style={{ fontSize: 11, color: 'var(--color-info)', margin: '6px 2px 0' }}>
            点击下方任意 agent 立即发起 1 对 1 对话,在对话列表里会带 👤 标志。
          </p>
        )}
      </div>
      {!isDirect && (
        <div className={styles.formField}>
          <label className={styles.formLabel}>群名称:</label>
          <input type="text" value={groupName} onChange={e => setGroupName(e.target.value)}
            placeholder="输入群名称" className={styles.formInput} />
        </div>
      )}
      {!isDirect && (
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
          </select>
          {isPatrol && (
            <p style={{ fontSize: 11, color: 'var(--color-info)', margin: '6px 2px 0' }}>
              巡检群全局限 1 个(归档/删除后才能再建),只选 1 个 agent 作为巡检员。
              建群后自动创建每小时巡检任务,可在工具箱「Issue 巡检」开关。
            </p>
          )}
        </div>
      )}
      <div className={styles.formField}>
        <label className={styles.formLabel}>
          {isDirect ? '选择对方(点击立即发起):' : '选择成员:'}
          {(isDirect || isPatrol) && !isDirect && <span style={{ fontWeight: 400, fontSize: 11, marginLeft: 8, color: 'var(--color-info)' }}>限选 {maxMembers} 人</span>}
        </label>
        <div className={styles.agentCheckList}>
          {otherAgents.map(agent => {
            const checked = selectedMembers.includes(agent.name)
            const disabled = (isDirect || isPatrol) && !checked && selectedMembers.length >= maxMembers
            return (
              <label key={agent.id} className={styles.agentCheckItem}
                style={disabled ? { opacity: 0.4 } : (isDirect ? { cursor: 'pointer' } : undefined)}>
                <input type="checkbox" checked={checked} disabled={disabled}
                  onChange={() => handleToggleMember(agent.name)} />
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
        {isDirect && submitting && (
          <p style={{ fontSize: 11, color: 'var(--color-info)', margin: '6px 2px 0' }}>创建中...</p>
        )}
      </div>
      {!isDirect && (
        <>
      <div className={styles.formField}>
        <label className={styles.formLabel}>工作目录（可选）:</label>
        <input type="text" value={workingDir} onChange={e => setWorkingDir(e.target.value)}
          placeholder="例如: /Users/me/code/my-repo 或 ~/code/my-repo" className={styles.formInput} />
        <p style={{ fontSize: 11, color: 'var(--color-slate)', margin: '6px 2px 0' }}>
          支持 ~/ 自动展开。必须是已存在的目录；不填则默认使用 ~/.rotom/artifacts/&lt;群id&gt;（自动创建）。
        </p>
      </div>
      <div className={styles.formField}>
        <label className={styles.formLabel}>内置 repo(可选):</label>
        <input type="text" value={repoUrl} onChange={e => setRepoUrl(e.target.value)}
          placeholder="主仓库 URL,如 git@github.com:org/repo.git;留空则不启用 worktree" className={styles.formInput} />
        <input type="text" value={repoDefaultBranch} onChange={e => setRepoDefaultBranch(e.target.value)}
          placeholder="默认分支(如 main);留空用仓库默认" className={styles.formInput}
          style={{ marginTop: 6 }} />
        <select value={worktreeMode} onChange={e => setWorktreeMode(e.target.value as 'group' | 'issue')}
          className={styles.formSelect} style={{ marginTop: 6 }}>
          <option value="group">worktree 策略:group(群共享一个 worktree,轻量)</option>
          <option value="issue">worktree 策略:issue(每 issue 独立 worktree,多分支并行)</option>
        </select>
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--color-slate)' }}>额外仓库(可选)</span>
            <button type="button" onClick={addExtra}
              style={{ border: '1px solid var(--border-color-light, #ddd)', background: 'transparent', color: 'var(--color-navy, #1a365d)', borderRadius: 4, padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}>
              + 添加
            </button>
          </div>
          {extraRepos.map((e, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 110px 28px', gap: 6, marginBottom: 6 }}>
              <input type="text" value={e.id} onChange={ev => updateExtra(idx, 'id', ev.target.value)}
                placeholder="id(如 deposit-home)" className={styles.formInput} style={{ fontSize: 11 }} />
              <input type="text" value={e.url} onChange={ev => updateExtra(idx, 'url', ev.target.value)}
                placeholder="URL" className={styles.formInput} style={{ fontSize: 11 }} />
              <input type="text" value={e.branch} onChange={ev => updateExtra(idx, 'branch', ev.target.value)}
                placeholder="分支(可空)" className={styles.formInput} style={{ fontSize: 11 }} />
              <button type="button" onClick={() => removeExtra(idx)}
                style={{ border: '1px solid var(--border-color-light, #ddd)', background: 'transparent', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#c00' }}
                title="删除">
                ✕
              </button>
            </div>
          ))}
          <p style={{ fontSize: 11, color: 'var(--color-slate)', margin: '4px 2px 0' }}>
            mountPath 自动 = <code>repos/&lt;id&gt;</code>;agent 在 primary worktree 里通过该路径访问额外仓库。
          </p>
        </div>
        <p style={{ fontSize: 11, color: 'var(--color-slate)', margin: '6px 2px 0' }}>
          配 repo 后,群内 issue/chat 在 worktree 里跑(agent cwd = <code>~/.rotom/repos/&lt;repoName&gt;-&lt;id8&gt;-wt/group-&lt;groupId8&gt;/</code>)。bare clone 全局共享,只克隆一次。
        </p>
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
        </>
      )}
    </Modal>
  )
}
