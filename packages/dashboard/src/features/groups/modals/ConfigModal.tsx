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
 * 选择「我的身份」modal —— Dashboard 这边必须绑真人(category="真人")。
 * 列表里真人置顶并标记「默认」,非真人项可点但会提示"建议选真人"。
 * 没真人时显示「请先去员工管理创建一个真人 agent」引导。
 */
export function ConfigModal({ open, onConfigured, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const currentName = typeof window !== 'undefined' ? localStorage.getItem('chat_agent_name') ?? '' : ''

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

  const realPeople = agents.filter(a => a.profile?.category === '真人')
  const sorted = [...realPeople, ...agents.filter(a => a.profile?.category !== '真人')]

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
        Dashboard 这边的你是「真人」。挑一个真人 agent 作为操作身份 —— 本机/局域网免 token,直接绑定。
      </p>

      {loading && <div style={{ fontSize: 13, color: 'var(--color-slate)' }}>加载中…</div>}
      {error && <div style={{ fontSize: 13, color: 'var(--color-danger, #dc2626)' }}>{error}</div>}

      {!loading && !error && realPeople.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-danger, #dc2626)', padding: '12px', background: 'var(--color-danger-bg, #fef2f2)', borderRadius: 6 }}>
          团队里还没有「真人」agent。请先到「员工管理」页创建一个 category=真人的 agent,再回来选身份。
        </div>
      )}

      {!loading && !error && realPeople.length > 0 && agents.length > realPeople.length && (
        <div style={{ fontSize: 12, color: 'var(--color-slate)', marginBottom: 8, padding: '6px 10px', background: 'var(--color-tag-bg)', borderRadius: 4 }}>
          建议选真人(置顶带 ● 标)。选非真人可能与 executor worker 共用 WS,导致连接互相挤掉。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
        {sorted.map(a => {
          const isReal = a.profile?.category === '真人'
          return (
          <button
            key={a.id}
            onClick={() => {
              localStorage.setItem('chat_agent_name', a.name)
              onConfigured(a.name)
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px',
              background: isReal ? 'var(--color-success-bg, #f0fdf4)' : 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              cursor: 'pointer',
              textAlign: 'left',
              opacity: isReal ? 1 : 0.7,
            }}
          >
            <Avatar name={a.name} src={a.avatar_url ?? undefined} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13 }}>
                {isReal && <span style={{ color: 'var(--color-success, #16a34a)', marginRight: 4 }}>●</span>}
                {a.name}
                {a.name === currentName && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>· 当前</span>}
              </div>
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
          )
        })}
      </div>
    </Modal>
  )
}
