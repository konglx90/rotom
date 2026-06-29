import { useEffect, useMemo, useState } from 'react'
import type { Agent, AgentProfile, GroupMember } from '../../../api/types'
import { Avatar } from '../../../components/ui/Avatar'
import { Modal } from '../../../components/ui/Modal/Modal'
import { WorkingDirModal } from './WorkingDirModal'
import { MemberProfileModal } from './MemberProfileModal'
import { GuidanceTemplatePicker } from './GuidanceTemplatePicker'
import { groupsApi } from '../../../api/groups'
import { skillsApi } from '../../../api/skills'
import type { SkillIndex, SkillBinding } from '../../../api/skills'
import { useChatContext } from '../../../context/ChatContext'

interface Props {
  open: boolean
  members: GroupMember[]
  agents: Agent[]
  groupId: string
  groupName: string
  groupWorkingDir: string | null
  groupGuidancePrompt?: string | null
  onUpdateGuidancePrompt?: (groupId: string, prompt: string | null) => Promise<void>
  onClose: () => void
  onUpdateMemberWorkingDir: (groupId: string, agentName: string, dir: string | null) => Promise<void> | void
  onProfilesChanged?: () => void
}

function parseProfile(json: string | null): AgentProfile | null {
  if (!json) return null
  try {
    const obj = JSON.parse(json) as Record<string, unknown>
    const out: AgentProfile = {}
    if (typeof obj.position === 'string') out.position = obj.position
    if (typeof obj.bio === 'string') out.bio = obj.bio
    if (typeof obj.category === 'string') out.category = obj.category
    return out
  } catch {
    return null
  }
}

export function MemberListModal({
  open,
  members,
  agents,
  groupId,
  groupName,
  groupWorkingDir,
  groupGuidancePrompt,
  onUpdateGuidancePrompt,
  onClose,
  onUpdateMemberWorkingDir,
  onProfilesChanged,
}: Props) {
  const [editingDir, setEditingDir] = useState<GroupMember | null>(null)
  const [editingProfile, setEditingProfile] = useState<GroupMember | null>(null)
  const [guidanceValue, setGuidanceValue] = useState(groupGuidancePrompt || '')
  const [guidanceSaving, setGuidanceSaving] = useState(false)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)

  const closeEditingDir = () => setEditingDir(null)
  const closeEditingProfile = () => setEditingProfile(null)

  const guidanceDirty = guidanceValue.trim() !== (groupGuidancePrompt || '').trim()

  const saveGuidance = async () => {
    if (!onUpdateGuidancePrompt || !guidanceDirty) return
    setGuidanceSaving(true)
    try {
      await onUpdateGuidancePrompt(groupId, guidanceValue.trim() || null)
    } finally {
      setGuidanceSaving(false)
    }
  }

  const agentsByName = useMemo(() => {
    const m = new Map<string, Agent>()
    for (const a of agents) m.set(a.name, a)
    return m
  }, [agents])

  return (
    <>
      <Modal open={open} title="群成员" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
          {members.map(m => {
            const name = m.agent_name
            const agent = agentsByName.get(name)
            const isOnline = agent?.status === 'online'
            const hasOverride = Boolean(m.working_dir)
            const groupProfile = parseProfile(m.profile)
            const hasProfileOverride = Boolean(groupProfile && Object.keys(groupProfile).length > 0)
            return (
              <div
                key={name}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: '8px 4px',
                  borderBottom: '1px solid rgba(0,0,0,0.05)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar name={name} src={agent?.avatar_url} size={32} />
                  <span style={{ fontSize: 14, color: 'var(--color-navy)', fontWeight: 500 }}>{name}</span>
                  <span
                    title={m.working_dir || groupWorkingDir || undefined}
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: hasOverride ? 'rgba(99, 102, 241, 0.1)' : 'rgba(0,0,0,0.04)',
                      color: hasOverride ? 'rgb(99, 102, 241)' : 'var(--color-slate)',
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {hasOverride ? `📁 ${m.working_dir}` : '↩ 继承群'}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 12,
                      padding: '2px 10px',
                      borderRadius: 10,
                      background: isOnline ? 'rgba(52, 168, 83, 0.1)' : 'rgba(0,0,0,0.05)',
                      color: isOnline ? 'var(--color-success)' : 'var(--color-slate)',
                    }}
                  >
                    {isOnline ? '在线' : '离线'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingDir(m)}
                    title="设置该成员的工作目录"
                    style={{
                      border: '1px solid rgba(0,0,0,0.1)',
                      background: 'var(--color-surface)',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: 12,
                      cursor: 'pointer',
                      color: 'var(--color-navy)',
                    }}
                  >
                    📁 目录
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingProfile(m)}
                    title="设置该成员在群内的岗位/简介覆盖"
                    style={{
                      border: '1px solid rgba(0,0,0,0.1)',
                      background: hasProfileOverride ? 'rgba(99, 102, 241, 0.1)' : 'var(--color-surface)',
                      color: hasProfileOverride ? 'rgb(99, 102, 241)' : 'var(--color-navy)',
                      borderRadius: 6,
                      padding: '4px 8px',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {hasProfileOverride ? '📝 角色(已覆盖)' : '📝 角色'}
                  </button>
                </div>
                {(groupProfile || agent?.profile) && (
                  <div style={{ paddingLeft: 42, fontSize: 11, color: 'var(--color-slate)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {hasProfileOverride && (
                      <span style={{ color: 'rgb(99, 102, 241)', fontWeight: 500 }}>群内覆盖：</span>
                    )}
                    <span>岗位: {(groupProfile?.position ?? agent?.profile?.position) || '-'}</span>
                    <span>简介: {(groupProfile?.bio ?? agent?.profile?.bio) || '-'}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 群指导 prompt —— 全群一份,群内所有 agent 被唤起时拼到 prompt 上 */}
        {onUpdateGuidancePrompt && (
          <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 12, paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-navy)' }}>📋 群指导 prompt</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => setShowTemplatePicker(true)}
                  style={{
                    border: '1px solid rgba(0,0,0,0.12)',
                    background: 'transparent',
                    color: 'var(--color-navy)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  📚 从模板选择
                </button>
                {guidanceDirty && (
                  <button
                    type="button"
                    onClick={saveGuidance}
                    disabled={guidanceSaving}
                    style={{
                      border: 'none',
                      background: 'var(--color-primary, #4f46e5)',
                      color: '#fff',
                      borderRadius: 6,
                      padding: '4px 12px',
                      fontSize: 12,
                      cursor: guidanceSaving ? 'not-allowed' : 'pointer',
                      opacity: guidanceSaving ? 0.6 : 1,
                    }}
                  >
                    {guidanceSaving ? '保存中...' : '保存'}
                  </button>
                )}
              </div>
            </div>
            <textarea
              value={guidanceValue}
              onChange={(e) => setGuidanceValue(e.target.value)}
              placeholder="全群一份,群内所有 agent 被唤起时拼到 prompt 上。例:本群讨论 VR 需求,回复聚焦用户场景;提问加 #reply。"
              style={{
                width: '100%',
                minHeight: 70,
                padding: '8px 10px',
                border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--color-navy)',
                background: 'var(--color-surface, #fff)',
                outline: 'none',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
              spellCheck={false}
            />
            <div style={{ fontSize: 11, color: 'var(--color-slate)', marginTop: 4 }}>
              留空保存 = 清除。群级别硬约定,所有成员都会看到。
            </div>
          </div>
        )}

        <SkillBindingsSection groupId={groupId} memberAgentNames={members.map(m => m.agent_name)} />
      </Modal>

      {editingDir && (
        <WorkingDirModal
          open={Boolean(editingDir)}
          scope="member"
          scopeName={editingDir.agent_name}
          currentDir={editingDir.working_dir}
          fallbackDir={groupWorkingDir}
          onClose={closeEditingDir}
          onSubmit={(dir) => {
            onUpdateMemberWorkingDir(groupId, editingDir.agent_name, dir)
            closeEditingDir()
          }}
        />
      )}

      {editingProfile && (
        <MemberProfileModal
          open={Boolean(editingProfile)}
          agentName={editingProfile.agent_name}
          currentProfile={parseProfile(editingProfile.profile)}
          globalProfile={agentsByName.get(editingProfile.agent_name)?.profile ?? null}
          onClose={closeEditingProfile}
          onSubmit={async (profile) => {
            await groupsApi.setMemberProfile(groupId, editingProfile.agent_name, profile)
            onProfilesChanged?.()
            closeEditingProfile()
          }}
        />
      )}

      {showTemplatePicker && (
        <GuidanceTemplatePicker
          open={showTemplatePicker}
          groupId={groupId}
          groupName={groupName}
          memberAgentNames={members.map(m => m.agent_name)}
          onPromptApplied={(resolved) => setGuidanceValue(resolved)}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}
    </>
  )
}

/** 每个 agent 勾选该群要绑定的 skill。勾选实时 bind/unbind。 */
function SkillBindingsSection({ groupId, memberAgentNames }: { groupId: string; memberAgentNames: string[] }) {
  const { myAgentName, agents } = useChatContext()
  const [allSkills, setAllSkills] = useState<SkillIndex[]>([])
  const [bindings, setBindings] = useState<SkillBinding[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string>('')

  // 真人不参与 skill 绑定(category === "真人"),优先取群成员 profile override,回落全局 agent profile。
  const aiAgentNames = useMemo(() => {
    const byName = new Map(agents.map(a => [a.name, a]))
    return memberAgentNames.filter(aname => {
      const member = byName.get(aname)
      let category: string | undefined
      if (member?.profile?.category) category = member.profile.category
      return category !== '真人'
    })
  }, [memberAgentNames, agents])

  const reload = () => {
    Promise.all([skillsApi.list(), skillsApi.listBindings(groupId)])
      .then(([s, b]) => { setAllSkills(s); setBindings(b) })
      .catch(e => setErr((e as Error).message))
  }
  useEffect(() => { reload() }, [groupId])

  const toggle = async (agentName: string, skill: SkillIndex) => {
    const key = `${agentName}:${skill.id}`
    if (busy) return
    setBusy(key)
    try {
      const isBound = bindings.some(b => b.agent_name === agentName && b.skill_id === skill.id)
      if (isBound) {
        await skillsApi.unbind(groupId, agentName, skill.name)
      } else {
        await skillsApi.bind(groupId, agentName, skill.name, myAgentName)
      }
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  if (aiAgentNames.length === 0) return null

  return (
    <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border-color-light, rgba(0,0,0,0.08))', borderRadius: 8, background: 'var(--color-surface, #fff)' }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-navy, #1a365d)' }}>⚡ 技能绑定(per agent)</div>
        <div style={{ fontSize: 11, color: 'var(--color-slate, #888)', marginTop: 2, lineHeight: 1.4 }}>
          勾选的 skill 在该 agent 执行时注入 prompt 指针;全局 skill 在工具箱管理
        </div>
      </div>
      {err && <div style={{ color: '#c00', fontSize: 12, marginBottom: 6 }}>{err}</div>}
      {allSkills.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-slate, #888)', padding: '8px 0' }}>
          暂无 skill。去工具箱「技能」tab 新建,或 <code>rotom memory promote-to-skill</code> 沉淀。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {aiAgentNames.map(aname => (
            <div key={aname} style={{ padding: '6px 0', borderTop: '1px solid var(--border-color-light, #eee)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--color-navy, #1a365d)' }}>{aname}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {allSkills.map(s => {
                  const checked = bindings.some(b => b.agent_name === aname && b.skill_id === s.id)
                  const key = `${aname}:${s.id}`
                  return (
                    <label key={s.id} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 11, padding: '4px 10px',
                      border: `1px solid ${checked ? 'var(--color-wise-green, #2f7a2f)' : 'var(--border-color-light, #ddd)'}`,
                      borderRadius: 6, cursor: busy === key ? 'wait' : 'pointer',
                      userSelect: 'none', lineHeight: 1.2,
                      background: checked ? 'rgba(47, 122, 47, 0.08)' : 'transparent',
                      color: checked ? 'var(--color-wise-green, #2f7a2f)' : 'var(--color-navy, #1a365d)',
                      opacity: busy === key ? 0.5 : 1,
                      transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy === key}
                        onChange={() => toggle(aname, s)}
                        style={{ margin: 0, accentColor: 'var(--color-wise-green, #2f7a2f)', cursor: busy === key ? 'wait' : 'pointer' }}
                      />
                      {s.name}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
