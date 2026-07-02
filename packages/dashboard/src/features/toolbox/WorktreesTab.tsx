/**
 * 工具箱 - Worktrees 全局视图。
 *
 * 列出本机所有 repo(bare clone)+ 各自 worktree,按 repo 分组。
 * 顶部统计:repo 数 / worktree 数 / 总磁盘。每个 repo 卡片下 worktree 用 grid 对齐。
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { reposApi, type RepoScanEntry } from '../../api/repos'
import { groupsApi } from '../../api/groups'
import { Button } from '../../components/ui/Button'
import styles from './WorktreesTab.module.css'

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`
}

/** path 形如 .../<repoName>-<repoId8>-wt/<slot>,取 slot */
function slotFromPath(wtPath: string): string | null {
  const parts = wtPath.split('/')
  const wtIdx = parts.findIndex(p => p.endsWith('-wt'))
  if (wtIdx < 0 || wtIdx + 1 >= parts.length) return null
  return parts[wtIdx + 1]
}

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
      const m: Record<string, { id: string; name: string }> = {}
      for (const g of groups) m[g.id.slice(0, 8)] = { id: g.id, name: g.name }
      setGroupMap(m)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  const [removing, setRemoving] = useState<string | null>(null)
  const handleRemove = async (wtPath: string) => {
    if (!window.confirm(`确认删除 worktree?\n${wtPath}\n\nbare clone 保留,只删这个工作树。`)) return
    setRemoving(wtPath)
    try {
      await reposApi.removeWorktree(wtPath)
      await reload()
    } catch (e) {
      window.alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRemoving(null)
    }
  }

  const stats = useMemo(() => {
    const repoCount = repos.length
    const wtCount = repos.reduce((s, r) => s + r.worktrees.length, 0)
    const totalBytes = repos.reduce((s, r) => s + r.sizeBytes, 0)
    return { repoCount, wtCount, totalBytes }
  }, [repos])

  if (loading) return <div className={styles.page}>加载中...</div>
  if (err) return (
    <div className={styles.page}>
      <div className={styles.error}>{err}</div>
      <Button variant="secondary" size="sm" onClick={reload}>重试</Button>
    </div>
  )

  if (repos.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📦</div>
          <p className={styles.emptyText}>本机还没有任何 repo 缓存</p>
          <p className={styles.emptyHint}>给 group 配置 repo_url 后,首次执行 issue/chat 会自动克隆</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>🌿 Worktrees</h2>
        <Button variant="ghost" size="sm" onClick={reload}>刷新</Button>
      </div>
      <p className={styles.subtitle}>
        本机所有 repo 的 bare clone + worktree。bare clone(<code>.git</code> 对象库)全局共享;worktree 各自一份 checkout,改的是各自工作树。
      </p>

      <div className={styles.stats}>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{stats.repoCount}</div>
          <div className={styles.statLabel}>📦 repos(bare clone)</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{stats.wtCount}</div>
          <div className={styles.statLabel}>🌿 worktrees</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{humanBytes(stats.totalBytes)}</div>
          <div className={styles.statLabel}>💾 总磁盘(bare clone)</div>
        </div>
      </div>

      {repos.map(repo => {
        const repoIdShort = repo.repoKey.split('-').pop() || ''
        return (
          <div key={repo.repoKey} className={styles.repoCard}>
            <div className={styles.repoHeader}>
              <span className={styles.repoIcon}>📦</span>
              <span className={styles.repoName}>{repo.repoName}</span>
              <span className={styles.repoIdShort}>{repoIdShort}</span>
              <span className={styles.repoMeta}>
                <span className={styles.repoMetaItem}>💾 {humanBytes(repo.sizeBytes)}</span>
                <span className={styles.repoMetaItem}>🌿 {repo.worktrees.length}</span>
              </span>
            </div>

            {repo.worktrees.length === 0 ? (
              <div className={styles.wtEmpty}>暂无 worktree(首次执行 issue/chat 时创建)</div>
            ) : (
              <div className={styles.wtList}>
                {repo.worktrees.map(wt => {
                  const slot = slotFromPath(wt.path)
                  const gid8 = groupId8FromSlot(slot)
                  const group = gid8 ? groupMap[gid8] : null
                  const isIssue = slot != null && !slot.startsWith('group-')
                  const orphan = !isIssue && gid8 != null && !group
                  return (
                    <div key={wt.path} className={`${styles.wtRow} ${orphan ? styles.wtRowOrphan : ''}`} title={wt.path}>
                      <span className={styles.wtType}>{isIssue ? '🔧' : '🌿'}</span>
                      <span className={styles.wtBranch}>{wt.branch || 'detached'}</span>
                      <span className={styles.wtPath}>{wt.path}</span>
                      <span className={styles.wtHead}>{wt.head}</span>
                      {group ? (
                        <button
                          type="button"
                          className={styles.wtGroupBtn}
                          onClick={() => navigate(`/dashboard/groups/${group.id}`)}
                          title={`跳转到群「${group.name}」`}
                        >
                          → {group.name}
                        </button>
                      ) : orphan ? (
                        <button
                          type="button"
                          className={styles.wtRemoveBtn}
                          onClick={() => handleRemove(wt.path)}
                          disabled={removing === wt.path}
                          title="群已删除,清理孤儿 worktree"
                        >
                          {removing === wt.path ? '删除中...' : '🗑 群已删 · 清理'}
                        </button>
                      ) : (
                        <span className={styles.wtNoGroup}>(无群关联)</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
