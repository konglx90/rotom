import { useMemo, useState } from 'react'
import type { Agent, AgentProfile, GroupMember } from '../../../api/types'
import { Avatar } from '../../../components/ui/Avatar'
import { Modal } from '../../../components/ui/Modal/Modal'
import { WorkingDirModal } from './WorkingDirModal'
import { MemberProfileModal } from './MemberProfileModal'
import { groupsApi } from '../../../api/groups'

interface Props {
  open: boolean
  members: GroupMember[]
  agents: Agent[]
  groupId: string
  groupWorkingDir: string | null
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
  groupWorkingDir,
  onClose,
  onUpdateMemberWorkingDir,
  onProfilesChanged,
}: Props) {
  const [editingDir, setEditingDir] = useState<GroupMember | null>(null)
  const [editingProfile, setEditingProfile] = useState<GroupMember | null>(null)

  const closeEditingDir = () => setEditingDir(null)
  const closeEditingProfile = () => setEditingProfile(null)

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
    </>
  )
}
