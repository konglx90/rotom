/**
 * E2edGroupsView — Landing page for E2ED (shown when no requirement is selected).
 *
 * Shows a welcome message and quick stats. Requirement list is in the sidebar.
 */

import { useState, useEffect } from 'react'
import { e2edApi, type E2edRequirement } from '../../api/e2ed'

const GREEN = '#9fe870'
const DARK_GREEN = '#163300'
const NEAR_BLACK = '#0e0f0c'
const GRAY = '#868685'

export function E2edGroupsView() {
  const [reqs, setReqs] = useState<E2edRequirement[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    e2edApi.list().then((data) => { setReqs(data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: GRAY }}>
      Loading...
    </div>
  )

  const activeReqs = reqs.filter(r => r.status !== 'CLOSED')

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', padding: 40, fontFamily: 'Inter, -apple-system, sans-serif',
      fontFeatureSettings: '"calt"',
    }}>
      {/* Green circle logo */}
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 32, fontWeight: 900, color: DARK_GREEN,
        marginBottom: 24,
      }}>E</div>

      <h1 style={{
        fontSize: 28, fontWeight: 900, color: NEAR_BLACK,
        letterSpacing: -0.5, marginBottom: 8, fontFeatureSettings: '"calt"',
      }}>端到端需求交付</h1>

      <p style={{
        fontSize: 16, color: GRAY, maxWidth: 400, textAlign: 'center',
        lineHeight: 1.5, marginBottom: 32, fontFeatureSettings: '"calt"',
      }}>
        Claude 交付，Codex 评审。<br />
        从需求到代码的完整可追溯流水线。
      </p>

      {activeReqs.length > 0 ? (
        <div style={{ fontSize: 14, color: NEAR_BLACK, fontWeight: 600, fontFeatureSettings: '"calt"' }}>
          从左侧选择一个需求查看详情
        </div>
      ) : (
        <div style={{ fontSize: 14, color: GRAY, fontFeatureSettings: '"calt"' }}>
          点击左侧 <span style={{
            display: 'inline-block', padding: '2px 12px', borderRadius: 9999,
            background: GREEN, color: DARK_GREEN, fontSize: 13, fontWeight: 600,
          }}>+ 新建需求</span> 开始
        </div>
      )}

      {/* ── Quick Tutorial ──────────────────────────────── */}
      <div style={{
        marginTop: 40, maxWidth: 560, width: '100%',
        background: '#fff', borderRadius: 24, padding: '28px 32px',
        boxShadow: 'rgba(14,15,12,0.06) 0px 0px 0px 1px',
        fontFeatureSettings: '"calt"',
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: NEAR_BLACK, marginBottom: 16, fontFeatureSettings: '"calt"' }}>
          快速上手
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Step num={1} title="创建需求" cmd="rotom e2ed start '需求描述' --cwd <项目目录>" />
          <Step num={2} title="生成方案" cmd="rotom e2ed deliver <id> --plan-only --cwd <项目目录>" />
          <Step num={3} title="方案评审" cmd="rotom e2ed review <id> --type plan --cwd <项目目录>" />
          <Step num={4} title="实现代码" cmd="rotom e2ed deliver <id> --code-only --cwd <项目目录>" />
          <Step num={5} title="代码评审" cmd="rotom e2ed review <id> --type code --cwd <项目目录>" />
          <Step num={6} title="关闭需求" cmd="rotom e2ed close <id>" />
        </div>
        <div style={{ marginTop: 16, padding: '10px 14px', borderRadius: 12, background: 'rgba(14,15,12,0.03)', fontSize: 12, color: GRAY, lineHeight: 1.6, fontFeatureSettings: '"calt"' }}>
          <strong style={{ color: NEAR_BLACK }}>双智能体协作：</strong>
          Claude 负责交付（生成方案 & 实现代码），Codex 负责评审（需求评审 & 方案评审 & 代码评审）。
          <code style={{ display: 'block', marginTop: 6, fontFamily: '"SF Mono", Menlo, monospace' }}>rotom e2ed --help</code>
        </div>
      </div>

      {/* Quick stats */}
      {reqs.length > 0 && (
        <div style={{
          display: 'flex', gap: 32, marginTop: 40,
          padding: '16px 32px', borderRadius: 30,
          border: '1px solid rgba(14,15,12,0.08)',
        }}>
          <Stat label="需求总数" value={reqs.length} />
          <Stat label="进行中" value={activeReqs.length} />
          <Stat label="已完成" value={reqs.filter(r => r.status === 'CLOSED').length} />
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: NEAR_BLACK, fontFeatureSettings: '"calt"' }}>{value}</div>
      <div style={{ fontSize: 12, color: GRAY, fontFeatureSettings: '"calt"' }}>{label}</div>
    </div>
  )
}

function Step({ num, title, cmd }: { num: number; title: string; cmd: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'start' }}>
      <div style={{
        width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
        background: GREEN, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700, color: DARK_GREEN, fontFeatureSettings: '"calt"',
      }}>{num}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: NEAR_BLACK, marginBottom: 4, fontFeatureSettings: '"calt"' }}>{title}</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(14,15,12,0.04)', borderRadius: 8, padding: '6px 10px',
        }}>
          <code style={{ flex: 1, fontSize: 12, fontFamily: '"SF Mono", Menlo, monospace', color: '#334155', fontFeatureSettings: '"calt"', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cmd}
          </code>
          <button onClick={handleCopy} style={{
            padding: '2px 8px', borderRadius: 9999, border: 'none',
            background: copied ? '#e2f6d5' : '#f1f5f9',
            color: copied ? '#054d28' : '#64748b',
            fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFeatureSettings: '"calt"',
          }}>
            {copied ? '✓' : '复制'}
          </button>
        </div>
      </div>
    </div>
  )
}
