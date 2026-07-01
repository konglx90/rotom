import { api } from './client'
import type { Group, CreateGroupDto } from './types'

/** 单条消息的"喂给 CLI 的 prompt"分层组成。点击消息气泡时弹出查看。 */
export interface ComposedPromptLayer {
  layer: 'rotom-cli' | 'group-basic' | 'group-guidance' | 'agent-role' | 'cwd' | 'task'
  content: string
  /** 数据源标注,如 "src/shared/rotom-cli-prompt.ts (constant)" */
  source: string
}

export interface ComposedPrompt {
  layers: ComposedPromptLayer[]
  final: string
  generated_at: string
  prompt_version: string
}

export interface GroupMessage {
  id: number
  sender: string
  content: string
  mentions: string
  created_at: string
  /** 老消息(null)无该字段;新消息(worker 透传了 composedPrompt)有完整分层。 */
  composed_prompt: ComposedPrompt | null
  /** 老消息(migration 022 之前)无该字段。新消息被用户中途中断时记 ISO 时间戳。 */
  cancelled_at?: string | null
  /** 虚拟 marker 行:群消息总数超过 head+tail 预算时,中间被省略的提示。
   *  sender='__truncated',前端渲染成居中 chip「已省略 N 条早期消息」。 */
  truncated?: { omitted: number }
}

export const groupsApi = {
  async list(): Promise<Group[]> {
    return api.get<Group[]>('/groups')
  },

  async getById(id: string): Promise<Group> {
    return api.get<Group>(`/groups/${id}`)
  },

  async create(data: CreateGroupDto): Promise<{ id: string; name: string; memberCount: number; working_dir?: string | null }> {
    return api.post<{ id: string; name: string; memberCount: number; working_dir?: string | null }>('/groups', data)
  },

  async updateWorkingDir(id: string, workingDir: string | null): Promise<{ ok: boolean; working_dir: string | null }> {
    return api.patch<{ ok: boolean; working_dir: string | null }>(`/groups/${id}`, { workingDir })
  },

  async setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }> {
    return api.patch<{ ok: boolean }>(`/groups/${id}`, { pinned })
  },

  async setArchived(id: string, archived: boolean): Promise<{ ok: boolean }> {
    return api.patch<{ ok: boolean }>(`/groups/${id}`, { archived })
  },

  async setStarred(id: string, starred: boolean): Promise<{ ok: boolean }> {
    return api.patch<{ ok: boolean }>(`/groups/${id}`, { starred })
  },

  async updateName(id: string, name: string): Promise<{ ok: boolean }> {
    return api.patch<{ ok: boolean }>(`/groups/${id}`, { name })
  },

  async updateGuidancePrompt(id: string, prompt: string | null): Promise<{ ok: boolean }> {
    return api.patch<{ ok: boolean }>(`/groups/${id}`, { guidancePrompt: prompt })
  },

  /**
   * 更新群内置 repo 配置(migration 051)。三列独立 patch:
   *  - repoUrl: 留空/null 清空 → group 回退现状(无 worktree)
   *  - repoDefaultBranch: 留空用仓库默认分支
   *  - extraRepos: 数组形如 [{id,url,branch?,mountPath}],留 null 清空
   */
  async updateRepo(
    id: string,
    data: { repoUrl?: string | null; repoDefaultBranch?: string | null; extraRepos?: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode?: 'group' | 'issue' | null },
  ): Promise<{ ok: boolean }> {
    return api.patch<{ ok: boolean }>(`/groups/${id}`, data)
  },

  async delete(id: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/groups/${id}`)
  },

  async addMembers(groupId: string, agentNames: string[]): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/groups/${groupId}/members`, { agentNames })
  },

  async removeMembers(groupId: string, agentNames: string[]): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/groups/${groupId}/members`, { agentNames })
  },

  async setMemberWorkingDir(
    groupId: string,
    agentName: string,
    workingDir: string,
  ): Promise<{ ok: boolean; working_dir: string }> {
    return api.put<{ ok: boolean; working_dir: string }>(
      `/groups/${groupId}/members/${encodeURIComponent(agentName)}/working-dir`,
      { workingDir },
    )
  },

  async clearMemberWorkingDir(
    groupId: string,
    agentName: string,
  ): Promise<{ ok: boolean; removed: boolean }> {
    return api.delete<{ ok: boolean; removed: boolean }>(
      `/groups/${groupId}/members/${encodeURIComponent(agentName)}/working-dir`,
    )
  },

  async setMemberProfile(
    groupId: string,
    agentName: string,
    profile: { position?: string; bio?: string; category?: string },
  ): Promise<{ ok: boolean; profile: { position?: string; bio?: string; category?: string } }> {
    return api.put<{ ok: boolean; profile: { position?: string; bio?: string; category?: string } }>(
      `/groups/${groupId}/members/${encodeURIComponent(agentName)}/profile`,
      profile,
    )
  },

  async getMessages(groupId: string): Promise<GroupMessage[]> {
    return api.get<GroupMessage[]>(`/groups/${groupId}/messages`)
  },

  async sendMessage(groupId: string, sender: string, content: string, mentions?: string[]): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/groups/${groupId}/messages`, { sender, content, mentions })
  },
}
