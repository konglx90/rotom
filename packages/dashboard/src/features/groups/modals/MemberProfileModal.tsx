import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { Textarea } from '../../../components/ui/Textarea'
import type { AgentProfile } from '../../../api/types'

interface MemberProfileModalProps {
  open: boolean
  agentName: string
  /** 当前群级别覆盖(profile JSON 解析后), null = 无覆盖。 */
  currentProfile: AgentProfile | null
  /** Agent 全局 profile, 用于显示「未覆盖时使用」的兜底值。 */
  globalProfile?: AgentProfile | null
  onClose: () => void
  onSubmit: (profile: { position?: string; bio?: string }) => Promise<void> | void
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
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setPosition(currentProfile?.position ?? '')
      setBio(currentProfile?.bio ?? '')
    }
  }, [open, currentProfile])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const profile: { position?: string; bio?: string } = {}
    if (position.trim()) profile.position = position.trim()
    if (bio.trim()) profile.bio = bio.trim()
    setSaving(true)
    try {
      await onSubmit(profile)
    } finally {
      setSaving(false)
    }
  }

  const fallbackHint = (field: 'position' | 'bio') => {
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
          <Input
            label="岗位"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            placeholder={fallbackHint('position')}
            disabled={saving}
          />
        </div>

        <div className="field" style={{ marginBottom: 16 }}>
          <Textarea
            label="简介"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder={fallbackHint('bio')}
            rows={3}
            disabled={saving}
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
