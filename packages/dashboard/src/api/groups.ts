import { api } from './client'
import type { Group, CreateGroupDto } from './types'

export interface GroupMessage {
  id: number
  sender: string
  content: string
  mentions: string
  created_at: string
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

  async delete(id: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/groups/${id}`)
  },

  async addMembers(groupId: string, agentNames: string[]): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/groups/${groupId}/members`, { agentNames })
  },

  async removeMembers(groupId: string, agentNames: string[]): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/groups/${groupId}/members`, { agentNames })
  },

  async getMessages(groupId: string): Promise<GroupMessage[]> {
    return api.get<GroupMessage[]>(`/groups/${groupId}/messages`)
  },

  async sendMessage(groupId: string, sender: string, content: string, mentions?: string[]): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/groups/${groupId}/messages`, { sender, content, mentions })
  },
}
