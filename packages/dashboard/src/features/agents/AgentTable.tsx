import { useState } from 'react'
import type { Agent } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Avatar } from '../../components/ui/Avatar'
import styles from './AgentTable.module.css'

interface AgentTableProps {
  agents: Agent[]
  onDelete?: (agent: Agent) => void
  onEditProfile?: (agent: Agent) => void
}

export function AgentTable({ agents, onDelete, onEditProfile }: AgentTableProps) {
  const [sortField, setSortField] = useState<keyof Agent>('name')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc')

  const sortedAgents = [...agents].sort((a, b) => {
    const aVal = a[sortField] || ''
    const bVal = b[sortField] || ''
    const comparison = String(aVal).localeCompare(String(bVal))
    return sortOrder === 'asc' ? comparison : -comparison
  })

  const handleSort = (field: keyof Agent) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortOrder('asc')
    }
  }

  if (agents.length === 0) {
    return (
      <div className={styles.empty}>
        <p>暂无员工数据</p>
        <p className={styles.hint}>请调整筛选条件或注册新员工</p>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th onClick={() => handleSort('name')}>
                名称 {sortField === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
              </th>
              <th onClick={() => handleSort('status')}>
                状态 {sortField === 'status' && (sortOrder === 'asc' ? '↑' : '↓')}
              </th>
              <th>类型</th>
              <th>详情</th>
              {(onDelete || onEditProfile) && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {sortedAgents.map((agent) => (
              <tr key={agent.id} className={agent.status === 'online' ? styles.online : styles.offline}>
                <td className={styles.name}>
                  <Avatar name={agent.name} src={agent.avatar_url} size={32} />
                  <span>{agent.name}</span>
                </td>
                <td>
                  <span className={`${styles.status} ${styles[agent.status]}`}>
                    {agent.status === 'online' ? '在线' : '离线'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span>
                      {agent.profile?.category
                        ? (agent.profile.category === '真人' ? '👤 ' : '🚀 ') + agent.profile.category
                        : '🚀 Agent'}
                    </span>
                    {agent.cliTool && (
                      <span style={{ fontSize: 11, color: '#6b7280' }}>🔧 {agent.cliTool}</span>
                    )}
                  </div>
                </td>
                <td className={styles.detailCell}>
                  <div className={styles.detailRow}>
                    {agent.profile?.position && <span className={styles.detailTag}>💼 {agent.profile.position}</span>}
                    {agent.profile?.bio && <span className={styles.detailTag}>📝 {agent.profile.bio}</span>}
                    {!agent.profile?.position && !agent.profile?.bio && agent.description && <span className={styles.detailDesc}>{agent.description}</span>}
                  </div>
                  {agent.description && (agent.profile?.position || agent.profile?.bio) && (
                    <div className={styles.detailDesc}>{agent.description}</div>
                  )}
                  {!agent.description && !agent.profile?.position && !agent.profile?.bio && <span className={styles.detailDesc}>-</span>}
                </td>
                {(onDelete || onEditProfile) && (
                  <td>
                    <div className={styles.actions}>
                    {onEditProfile && (
                      <Button variant="secondary" size="sm" onClick={() => onEditProfile(agent)}>
                        编辑
                      </Button>
                    )}
                    {onDelete && (
                      <Button variant="danger" outline size="sm" onClick={() => onDelete(agent)}>
                        删除
                      </Button>
                    )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
