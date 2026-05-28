import type { Agent } from '../../../api/types'
import { Avatar } from '../../../components/ui/Avatar'
import { Modal } from '../../../components/ui/Modal/Modal'

interface Props {
  open: boolean
  memberNames: string[]
  agents: Agent[]
  onClose: () => void
}

export function MemberListModal({ open, memberNames, agents, onClose }: Props) {
  return (
    <Modal open={open} title="群成员" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
        {memberNames.map(name => {
          const agent = agents.find(a => a.name === name)
          const isOnline = agent?.status === 'online'
          return (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 4px' }}>
              <Avatar name={name} size={32} />
              <span style={{ fontSize: 14, color: 'var(--color-navy)', fontWeight: 500 }}>{name}</span>
              <span style={{
                marginLeft: 'auto',
                fontSize: 12,
                padding: '2px 10px',
                borderRadius: 10,
                background: isOnline ? 'rgba(52, 168, 83, 0.1)' : 'rgba(0,0,0,0.05)',
                color: isOnline ? 'var(--color-success)' : 'var(--color-slate)',
              }}>
                {isOnline ? '在线' : '离线'}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
