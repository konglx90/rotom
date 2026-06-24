import { useState } from 'react'
import { shareApi } from '../../api/share'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'

interface ShareLinkModalProps {
  open: boolean
  groupId: string
  groupName: string
  onClose: () => void
}

/**
 * Modal shown after a Dashboard user clicks "Share" in the group header.
 *
 * Mints a share token via POST /api/groups/:groupId/shares and displays the
 * resulting visitor URL with copy / revoke buttons. The URL carries the
 * `?share=<token>` query parameter — opening it in any browser (including
 * incognito) lands on a read-only visitor view of this group.
 */
export function ShareLinkModal({ open, groupId, groupName, onClose }: ShareLinkModalProps) {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [copied, setCopied] = useState(false)

  const url = token
    ? `${window.location.origin}/dashboard/groups/${groupId}?share=${token}`
    : null

  const handleCreate = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await shareApi.create(groupId)
      setToken(res.token)
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成链接失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  const handleRevoke = async () => {
    if (!token) return
    setRevoking(true)
    try {
      await shareApi.revoke(token)
      setToken(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销失败')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <Modal open={open} title={`分享「${groupName}」`} onClose={onClose} size="md">
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--color-warm-dark, #64748b)', lineHeight: 1.6 }}>
        访客通过该链接可以查看群内的全部消息、Issue、产物和笔记，但无法发送消息或修改任何内容。
        链接仅存于内存，重启 Master 后失效；可随时撤销。
      </p>

      {error && (
        <div style={{ padding: 8, background: '#fef2f2', color: '#b91c1c', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {!token ? (
        <Button
          variant="primary"
          size="md"
          onClick={handleCreate}
          disabled={loading}
          style={{ width: '100%' }}
        >
          {loading ? '生成中…' : '生成分享链接'}
        </Button>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              readOnly
              value={url ?? ''}
              onFocus={e => e.currentTarget.select()}
              style={{
                flex: 1,
                padding: '8px 12px',
                border: '1px solid var(--border-color, #cbd5e1)',
                borderRadius: 6,
                fontSize: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                background: 'var(--color-canvas-subtle, #f8fafc)',
                color: 'var(--color-ink, #0f172a)',
                minWidth: 0,
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleCopy}
              style={{
                background: copied ? '#dcfce7' : undefined,
                color: copied ? '#166534' : undefined,
                whiteSpace: 'nowrap',
              }}
            >
              {copied ? '✓ 已复制' : '复制'}
            </Button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevoke}
              disabled={revoking}
              style={{ color: '#b91c1c', border: '1px solid #fecaca' }}
            >
              {revoking ? '撤销中…' : '撤销链接'}
            </Button>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>
              重启 Master 后此链接自动失效
            </span>
          </div>
        </>
      )}
    </Modal>
  )
}
