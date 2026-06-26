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

  async listRefs(groupId: string): Promise<ArtifactRefs> {
    return api.get<ArtifactRefs>(`/artifacts/${groupId}/refs`)
  },
}
