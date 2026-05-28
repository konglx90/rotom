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
}
