/**
 * 工具箱 - Worktrees 全局视图。
 *
 * 列出本机所有 repo(bare clone)+ 各自 worktree,按 repo 分组。
 * 每个 worktree 显示:所属 group(从 slot 反推)/分支/路径/HEAD。
 * 提供「打开终端」「跳转 group」快捷入口(若 slot 含 groupId)。
 *
 * worktree 物理在 executor 本机,master 与 executor 同机时通过 GET /repos/worktrees
 * 扫描得到。跨机器部署(本机无 repos/)显示空提示。
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { reposApi, type RepoScanEntry } from '../../api/repos'
import { groupsApi } from '../../api/groups'
import { Button } from '../../components/ui/Button'
import styles from './ManagementTab.module.css'

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`
}

/** 从 worktree path 反推 slot。path 形如 .../<repoName>-<repoId8>-wt/<slot> */
function slotFromPath(wtPath: string): string | null {
  const parts = wtPath.split('/')
  const wtIdx = parts.findIndex(p => p.endsWith('-wt'))
  if (wtIdx < 0 || wtIdx + 1 >= parts.length) return null
  return parts[wtIdx + 1]
}

/** slot = group-<groupId8> → groupId8;否则 null(issue 模式 slot 是 issueId8) */
function groupId8FromSlot(slot: string | null): string | null {
  if (!slot) return null
  if (slot.startsWith('group-')) return slot.slice('group-'.length)
  return null
}

export function WorktreesTab() {
  const navigate = useNavigate()
  const [repos, setRepos] = useState<RepoScanEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [groupMap, setGroupMap] = useState<Record<string, { id: string; name: string }>>({})

  const reload = async () => {
    setLoading(true)
    setErr(null)
    try {
      const [list, groups] = await Promise.all([reposApi.listWorktrees(), groupsApi.list()])
      setRepos(list)
      // 按 groupId8 建反查表(用于 worktree 关联到 group 名)
      const m: Record<string, { id: string; name: string }> = {}
      for (const g of groups) {
        m[g.id.slice(0, 8)] = { id: g.id, name: g.name }
      }
      setGroupMap(m)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  if (loading) return <div className={styles.page}>加载中...</div>
  if (err) return <div className={styles.page}><div style={{ color: '#c00' }}>{err}</div><Button variant="secondary" size="sm" onClick={reload} style={{ marginTop: 8 }}>重试</Button></div>

  if (repos.length === 0) {
    return (
      <div className={styles.page}>
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-slate, #888)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
          <p>本机还没有任何 repo 缓存</p>
          <p style={{ fontSize: 12, marginTop: 4 }}>给 group 配置 repo_url 后,首次执行 issue/chat 会自动克隆</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>🌿 Worktrees(全局)</h2>
        <Button variant="ghost" size="sm" onClick={reload}>刷新</Button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--color-slate, #888)', margin: '0 0 16px 0' }}>
        本机所有 repo 的 bare clone + worktree。bare clone(<code>.git</code> 对象库)全局共享;worktree 各自一份 checkout。
      </p>

      {repos.map(repo => (
        <div key={repo.repoKey} style={{ marginBottom: 16, border: '1px solid var(--border-color-light, #e2e8f0)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', background: 'var(--color-canvas, #f7fafc)', borderBottom: '1px solid var(--border-color-light, #e2e8f0)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14 }}>📦</span>
            <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>{repo.repoName}</strong>
            <span style={{ fontSize: 11, color: 'var(--color-slate, #888)', fontFamily: 'var(--font-mono, monospace)' }}>-{repo.repoKey.split('-').pop()}</span>
            <span style={{ fontSize: 11, color: 'var(--color-slate, #888)' }}>· {humanBytes(repo.sizeBytes)} · {repo.worktrees.length} worktree{repo.worktrees.length === 1 ? '' : 's'}</span>
          </div>

          {repo.worktrees.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--color-slate, #888)' }}>
              暂无 worktree(首次执行 issue/chat 时创建)
            </div>
          ) : (
            <div style={{ padding: '4px 0' }}>
              {repo.worktrees.map(wt => {
                const slot = slotFromPath(wt.path)
                const gid8 = groupId8FromSlot(slot)
                const group = gid8 ? groupMap[gid8] : null
                const isIssue = slot != null && !slot.startsWith('group-')
                return (
                  <div key={wt.path} style={{ padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, borderBottom: '1px solid var(--border-color-light, #f0f0f0)' }}>
                    <span style={{ flexShrink: 0 }}>
                      {isIssue ? '🔧' : '🌿'}
                    </span>
                    <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-navy, #1a365d)', fontWeight: 600 }}>
                      [{wt.branch || 'detached'}]
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)', fontSize: 11, color: 'var(--color-slate, #888)' }} title={wt.path}>
                      {wt.path}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--color-slate, #888)' }}>
                      {wt.head}
                    </span>
                    {group && (
                      <button
                        type="button"
                        onClick={() => navigate(`/dashboard/groups/${group.id}`)}
                        style={{ flexShrink: 0, border: '1px solid var(--border-color-light, #ddd)', background: 'transparent', color: 'var(--color-navy, #1a365d)', borderRadius: 4, padding: '1px 8px', fontSize: 11, cursor: 'pointer' }}
                        title={`跳转到群「${group.name}」`}
                      >
                        → {group.name}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
