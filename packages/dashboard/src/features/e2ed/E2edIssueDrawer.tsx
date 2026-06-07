import { useState, useEffect } from 'react'
import { issuesApi } from '../../api/issues'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { IssueDetail } from '../groups/IssueDetail'
import { useChatContext } from '../../context/ChatContext'
import { useSocket } from '../../context/SocketContext'

const NEAR_BLACK = '#0e0f0c'
const GRAY = '#868685'
const ff = { fontFeatureSettings: '"calt"' } as React.CSSProperties

interface E2edIssueDrawerProps {
  issueId: string
  groupId: string
  onClose: () => void
}

export function E2edIssueDrawer({ issueId, onClose }: E2edIssueDrawerProps) {
  const [tab, setTab] = useState<'product' | 'process'>('product')
  const [result, setResult] = useState<string | null>(null)
  const [issueType, setIssueType] = useState<string | null>(null)
  const { agents } = useChatContext()
  const { lastIssueChange } = useSocket()

  // Fetch issue result
  useEffect(() => {
    issuesApi.getById(issueId).then((data) => {
      setResult(data.result || null)
      setIssueType(data.type || null)
      if (data.result) setTab('product')
    }).catch(() => {})
  }, [issueId])

  // Re-fetch on WS change
  useEffect(() => {
    if (!lastIssueChange || lastIssueChange.issueId !== issueId) return
    issuesApi.getById(issueId).then((data) => {
      setResult(data.result || null)
      setIssueType(data.type || null)
    })
  }, [lastIssueChange, issueId])

  // ESC close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const productLabel = issueType === 'review' ? '评审报告' : '产物'

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(14,15,12,0.3)',
        zIndex: 1000, backdropFilter: 'blur(2px)',
      }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 640,
        background: '#fff', boxShadow: '-4px 0 24px rgba(14,15,12,0.1)',
        zIndex: 1001, display: 'flex', flexDirection: 'column',
        fontFamily: 'Inter, -apple-system, sans-serif', ...ff,
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 20px', borderBottom: '1px solid rgba(14,15,12,0.08)',
          flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: NEAR_BLACK, ...ff }}>任务详情</span>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: '50%', border: 'none',
            background: '#f1f5f9', color: GRAY, fontSize: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>&times;</button>
        </div>

        {result ? (
          <>
            {/* Tab bar */}
            <div style={{
              display: 'flex', borderBottom: '1px solid rgba(14,15,12,0.08)',
              flexShrink: 0, padding: '0 16px', background: '#fff',
            }}>
              <TabButton active={tab === 'product'} label={productLabel} onClick={() => setTab('product')} />
              <TabButton active={tab === 'process'} label="执行过程" onClick={() => setTab('process')} />
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {tab === 'product' ? (
                <div style={{ padding: '20px 24px', fontSize: 14, lineHeight: 1.6, color: '#334155' }}>
                  <MarkdownContent content={result} />
                </div>
              ) : (
                <IssueDetail
                  issueId={issueId}
                  agents={agents}
                  groupMembers={[]}
                  onBack={onClose}
                />
              )}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <IssueDetail
              issueId={issueId}
              agents={agents}
              groupMembers={[]}
              onBack={onClose}
            />
          </div>
        )}
      </div>
    </>
  )
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '10px 16px', border: 'none', background: 'transparent',
      borderBottom: active ? '2px solid #0e0f0c' : '2px solid transparent',
      color: active ? NEAR_BLACK : GRAY, fontWeight: active ? 600 : 400,
      fontSize: 13, cursor: 'pointer', ...ff, transition: 'all 0.15s',
    }}>{label}</button>
  )
}
