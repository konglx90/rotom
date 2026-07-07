import { api } from './client'
import type { ArtifactContent, ArtifactListing, ArtifactOriginal } from './types'

export interface ArtifactDiff {
  path: string
  base: string
  repoRoot: string | null
  relInRepo?: string
  diff: string
  note?: string
}

export interface ArtifactRefs {
  /** 全部分支+tag 原始列表(for-each-ref 输出,带 `tags/` 前缀)。 */
  refs: string[]
  /** 仅分支(refname 不以 `tags/` 开头)。 */
  heads: string[]
  /** 仅 tag(已剥离 `tags/` 前缀)。 */
  tags: string[]
  /** 当前 HEAD 分支名(可能为空)。 */
  head: string
  repoRoot?: string | null
  /** 当请求带了 repo 参数时,回显的 repo 标签("primary" 或 extras.id)。 */
  repo?: string
  note?: string
}

/** 「分支对比」模式:`base..head` 之间的变更文件清单 + 统计。 */
export interface BranchDiffFile {
  path: string
  /** 单字符状态:A / M / D / R / C 等(已剥离 score)。 */
  status: string
  additions: number
  deletions: number
  /** rename/copy 的源路径,仅 status 为 R/C 时有值。 */
  fromPath?: string
}

export interface BranchDiffResponse {
  repo: string
  base: string
  head: string
  files: BranchDiffFile[]
  stats: { filesChanged: number; additions: number; deletions: number }
  truncated: boolean
  repoRoot?: string | null
  note?: string
}

/** 任意 ref 下某文件的内容(`git show <ref>:<path>`)。 */
export interface ContentAtRef {
  path: string
  ref: string
  content: string
  note?: string
}

export const artifactsApi = {
  async list(groupId: string): Promise<ArtifactListing> {
    return api.get<ArtifactListing>(`/artifacts/${groupId}`)
  },

  async getContent(groupId: string, filePath: string): Promise<ArtifactContent> {
    return api.get<ArtifactContent>(`/artifacts/${groupId}/content?path=${encodeURIComponent(filePath)}`)
  },

  async getOriginal(groupId: string, filePath: string, base = 'HEAD'): Promise<ArtifactOriginal> {
    return api.get<ArtifactOriginal>(
      `/artifacts/${groupId}/original?path=${encodeURIComponent(filePath)}&base=${encodeURIComponent(base)}`,
    )
  },

  async getDiff(groupId: string, filePath: string, base = 'HEAD'): Promise<ArtifactDiff> {
    return api.get<ArtifactDiff>(
      `/artifacts/${groupId}/diff?path=${encodeURIComponent(filePath)}&base=${encodeURIComponent(base)}`,
    )
  },

  async listRefs(groupId: string, repo?: string): Promise<ArtifactRefs> {
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : ''
    return api.get<ArtifactRefs>(`/artifacts/${groupId}/refs${qs}`)
  },

  async branchDiff(
    groupId: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<BranchDiffResponse> {
    const qs = `?repo=${encodeURIComponent(repo)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`
    return api.get<BranchDiffResponse>(`/artifacts/${groupId}/branch-diff${qs}`)
  },

  async getContentAtRef(
    groupId: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<ContentAtRef> {
    const qs = `?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(ref)}`
    return api.get<ContentAtRef>(`/artifacts/${groupId}/content-at-ref${qs}`)
  },
}
