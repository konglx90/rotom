import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import type { AgentProfile } from '../../../api/types'

interface MemberProfileModalProps {
  open: boolean
  agentName: string
  /** 当前群级别覆盖(profile JSON 解析后), null = 无覆盖。 */
  currentProfile: AgentProfile | null
  /** Agent 全局 profile, 用于显示「未覆盖时使用」的兜底值。 */
  globalProfile?: AgentProfile | null
  onClose: () => void
  onSubmit: (profile: { position?: string; bio?: string; category?: string }) => Promise<void> | void
}

/**
 * 群成员 profile 覆盖编辑。提交空对象等同于清除覆盖(后端把空对象存为 NULL)。
 * 字段留空 = 不写入覆盖 = 沿用 agent 全局值。
 */
export function MemberProfileModal({
  open,
  agentName,
  currentProfile,
  globalProfile,
  onClose,
  onSubmit,
}: MemberProfileModalProps) {
  const [position, setPosition] = useState('')
  const [bio, setBio] = useState('')
  const [category, setCategory] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setPosition(currentProfile?.position ?? '')
      setBio(currentProfile?.bio ?? '')
      setCategory(currentProfile?.category ?? '')
    }
  }, [open, currentProfile])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const profile: { position?: string; bio?: string; category?: string } = {}
    if (position.trim()) profile.position = position.trim()
    if (bio.trim()) profile.bio = bio.trim()
    if (category.trim()) profile.category = category.trim()
    setSaving(true)
    try {
      await onSubmit(profile)
    } finally {
      setSaving(false)
    }
  }

  const fallbackHint = (field: 'position' | 'bio' | 'category') => {
    const v = globalProfile?.[field]
    return v ? `未覆盖时使用全局值：${v}` : '未覆盖时无全局值'
  }

  return (
    <Modal
      open={open}
      title={`群内角色覆盖 — ${agentName}`}
      onClose={onClose}
      size="md"
    >
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(0,0,0,0.03)', borderRadius: 6, fontSize: 12, color: 'var(--color-slate)' }}>
          群级别覆盖优先于 agent 全局 profile。留空字段不写入覆盖，沿用全局值。
          提交时所有字段都为空 = 清除覆盖。
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--color-navy)' }}>岗位</label>
          <input
            type="text"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder={fallbackHint('position')}
            disabled={saving}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14 }}
          />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--color-navy)' }}>简介</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder={fallbackHint('bio')}
            rows={3}
            disabled={saving}
            style={{ width: '100%', resize: 'vertical', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14 }}
          />
        </div>

        <div className="field" style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4, color: 'var(--color-navy)' }}>类别</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder={fallbackHint('category')}
            disabled={saving}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14 }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button type="button" variant="secondary" size="md" onClick={onClose} disabled={saving}>取消</Button>
          <Button type="submit" variant="primary" size="md" disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
