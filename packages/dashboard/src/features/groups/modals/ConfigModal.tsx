import { useState, useEffect } from 'react'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import styles from '../GroupChatView.module.css'

interface Props {
  open: boolean
  onConfigured: (name: string, token: string) => void
  onClose: () => void
}

export function ConfigModal({ open, onConfigured, onClose }: Props) {
  const [token, setToken] = useState('')
  const [resolvedName, setResolvedName] = useState('')
  const [error, setError] = useState('')
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    if (!open) return
    const savedToken = localStorage.getItem('chat_agent_token') || ''
    setToken(savedToken)
    setResolvedName('')
    setError('')
  }, [open])

  // 粘贴 mesh_xxx → 服务端反查匹配到的员工名
  useEffect(() => {
    const trimmed = token.trim()
    if (!trimmed) {
      setResolvedName(''); setError(''); setResolving(false)
      return
    }
    if (!trimmed.startsWith('mesh_')) {
      setResolvedName(''); setError('Token 必须以 mesh_ 开头'); setResolving(false)
      return
    }
    setResolving(true)
    setError('')
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/whoami', {
          headers: { Authorization: `Bearer ${trimmed}` },
          signal: ctrl.signal,
        })
        const data = await res.json()
        if (data?.kind === 'agent' && data.name) {
          setResolvedName(data.name); setError('')
        } else {
          setResolvedName(''); setError('Token 无效，未匹配到员工')
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setResolvedName(''); setError('网络请求失败')
        }
      } finally {
        setResolving(false)
      }
    }, 300)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [token])

  const canSave = !!resolvedName && !resolving
  const handleSave = () => {
    if (!canSave) return
    localStorage.setItem('chat_agent_name', resolvedName)
    localStorage.setItem('chat_agent_token', token.trim())
    onConfigured(resolvedName, token.trim())
  }

  return (
    <Modal
      open={open}
      title="选择我的身份"
      footer={
        <div className={styles.modalActions}>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
          <Button variant="primary" size="md" onClick={handleSave} disabled={!canSave}>
            绑定
          </Button>
        </div>
      }
    >
      <p style={{ color: 'var(--color-slate)', fontSize: 14, marginBottom: 16 }}>
        Dashboard 这边的你是「真人」。粘贴一个员工的 Mesh Token，名字会自动匹配出来。
      </p>
      <div className={styles.formField}>
        <Input
          label="Mesh Token："
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canSave) handleSave() }}
          placeholder="例如: mesh_xxx"
          autoFocus
        />
      </div>
      <div style={{ minHeight: 22, marginTop: 4, fontSize: 13 }}>
        {resolving && <span style={{ color: 'var(--color-slate)' }}>匹配中…</span>}
        {!resolving && resolvedName && (
          <span style={{ color: 'var(--color-success, #16a34a)' }}>
            ✓ 已匹配到员工：<strong>{resolvedName}</strong>
          </span>
        )}
        {!resolving && error && (
          <span style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</span>
        )}
      </div>
    </Modal>
  )
}
