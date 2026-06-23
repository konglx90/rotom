import { useState } from 'react'
import { shareApi } from '../../api/share'

interface ShareLinkModalProps {
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
export function ShareLinkModal({ groupId, groupName, onClose }: ShareLinkModalProps) {
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
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.4)',
          zIndex: 100,
        }}
      />
      <div
        role="dialog"
        aria-label="分享群"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 520,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          padding: 24,
          zIndex: 101,
          boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#0f172a' }}>
            分享「{groupName}」
          </h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 20,
              cursor: 'pointer',
              color: '#64748b',
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
          访客通过该链接可以查看群内的全部消息、Issue、产物和笔记，但无法发送消息或修改任何内容。
          链接仅存于内存，重启 Master 后失效；可随时撤销。
        </p>

        {error && (
          <div style={{ padding: 8, background: '#fef2f2', color: '#b91c1c', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {error}
          </div>
        )}

        {!token ? (
          <button
            onClick={handleCreate}
            disabled={loading}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: loading ? '#cbd5e1' : '#0f172a',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              cursor: loading ? 'wait' : 'pointer',
            }}
          >
            {loading ? '生成中…' : '生成分享链接'}
          </button>
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
                  border: '1px solid #cbd5e1',
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  background: '#f8fafc',
                  color: '#0f172a',
                  minWidth: 0,
                }}
              />
              <button
                onClick={handleCopy}
                style={{
                  padding: '8px 14px',
                  background: copied ? '#dcfce7' : '#0f172a',
                  color: copied ? '#166534' : '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {copied ? '✓ 已复制' : '复制'}
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                onClick={handleRevoke}
                disabled={revoking}
                style={{
                  padding: '6px 12px',
                  background: 'transparent',
                  color: '#b91c1c',
                  border: '1px solid #fecaca',
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: revoking ? 'wait' : 'pointer',
                }}
              >
                {revoking ? '撤销中…' : '撤销链接'}
              </button>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>
                重启 Master 后此链接自动失效
              </span>
            </div>
          </>
        )}
      </div>
    </>
  )
}