import { api } from './client'

/** 一个 worktree(从 `git worktree list` 解析)。 */
export interface WorktreeInfo {
  path: string
  branch: string
  head: string
}

/** 一个 repo(bare clone)及其所有 worktree。 */
export interface RepoScanEntry {
  repoKey: string
  repoName: string
  barePath: string
  worktrees: WorktreeInfo[]
  sizeBytes: number
}

/** group 的 worktree 推算信息。 */
export interface GroupWorktreeInfo {
  url: string
  branch: string | null
  mode: 'group' | 'issue'
  primaryPath: string
  primaryExists: boolean
  extras: {
    id: string
    url: string
    branch: string | null
    mountPath: string
    path: string
    exists: boolean
  }[]
}

export const reposApi = {
  /** 全局所有 repo + worktree 列表(工具箱视图用)。 */
  async listWorktrees(): Promise<RepoScanEntry[]> {
    return api.get<RepoScanEntry[]>('/repos/worktrees')
  },

  /** 删除指定 worktree(孤儿清理)。bare clone 保留。 */
  async removeWorktree(wtPath: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>('/repos/worktrees', { path: wtPath })
  },

  /** 某 group 的 worktree 推算信息(ArtifactPanel 顶部显示用)。 */
  async getGroupWorktree(groupId: string): Promise<GroupWorktreeInfo | null> {
    try {
      return await api.get<GroupWorktreeInfo>(`/groups/${groupId}/worktree`)
    } catch {
      return null
    }
  },
}
