import { useState } from 'react'
import type { Agent, GroupMember } from '../../../api/types'
import { Avatar } from '../../../components/ui/Avatar'
import { Modal } from '../../../components/ui/Modal/Modal'
import { WorkingDirModal } from './WorkingDirModal'

interface Props {
  open: boolean
  members: GroupMember[]
  agents: Agent[]
  groupId: string
  groupWorkingDir: string | null
  onClose: () => void
  onUpdateMemberWorkingDir: (groupId: string, agentName: string, dir: string | null) => Promise<void> | void
}

export function MemberListModal({
  open,
  members,
  agents,
  groupId,
  groupWorkingDir,
  onClose,
  onUpdateMemberWorkingDir,
}: Props) {
  const [editing, setEditing] = useState<GroupMember | null>(null)

  const closeEditing = () => setEditing(null)

  return (
    <>
      <Modal open={open} title="群成员" onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
          {members.map(m => {
            const name = m.agent_name
            const agent = agents.find(a => a.name === name)
            const isOnline = agent?.status === 'online'
            const hasOverride = Boolean(m.working_dir)
            return (
              <div
                key={name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 4px',
                }}
              >
                <Avatar name={name} size={32} />
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
                  onClick={() => setEditing(m)}
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
                  📁 设置
                </button>
              </div>
            )
          })}
        </div>
      </Modal>

      {editing && (
        <WorkingDirModal
          open={Boolean(editing)}
          scope="member"
          scopeName={editing.agent_name}
          currentDir={editing.working_dir}
          fallbackDir={groupWorkingDir}
          onClose={closeEditing}
          onSubmit={(dir) => {
            onUpdateMemberWorkingDir(groupId, editing.agent_name, dir)
            closeEditing()
          }}
        />
      )}
    </>
  )
}
