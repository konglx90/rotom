import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { Avatar } from '../../../components/ui/Avatar'
import type { Agent } from '../../../api/types'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  onConfigured: (name: string) => void
  onClose: () => void
}

/**
 * 选择「我的身份」modal —— OPC 模式下从 agent 列表里挑一个即可,无需 token。
 * 老的「粘贴 mesh_token 绑定身份」流程已废除(本机/局域网走 loopback 信任)。
 */
export function ConfigModal({ open, onConfigured, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    fetch('/api/agents')
      .then(r => r.json())
      .then((data: Agent[]) => setAgents(data))
      .catch(() => setError('加载员工列表失败'))
      .finally(() => setLoading(false))
  }, [open])

  return (
    <Modal
      open={open}
      title="选择我的身份"
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
        </div>
      }
    >
      <p style={{ color: 'var(--color-slate)', fontSize: 14, marginBottom: 16 }}>
        Dashboard 这边的你是「真人」。挑一个员工作为你的操作身份 —— 本机/局域网免 token,直接绑定。
      </p>

      {loading && <div style={{ fontSize: 13, color: 'var(--color-slate)' }}>加载中…</div>}
      {error && <div style={{ fontSize: 13, color: 'var(--color-danger, #dc2626)' }}>{error}</div>}

      {!loading && !error && agents.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-slate)' }}>
          暂无员工。先在「员工管理」页添加一个。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
        {agents.map(a => (
          <button
            key={a.id}
            onClick={() => {
              localStorage.setItem('chat_agent_name', a.name)
              onConfigured(a.name)
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <Avatar name={a.name} src={a.avatar_url ?? undefined} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{a.name}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {a.profile?.position || a.description || a.status}
              </div>
            </div>
            <span style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 3,
              background: a.status === 'online' ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-tag-bg)',
              color: a.status === 'online' ? 'var(--color-success, #16a34a)' : 'var(--color-text-tertiary)',
            }}>
              {a.status === 'online' ? '在线' : '离线'}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
