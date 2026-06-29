/**
 * Skills API client — 全局 skill 知识库 + (group, agent, skill) 绑定关系。
 *
 * skill 本身无可见性;可见性靠 /groups/:id/skills/:agent/bind 端点绑定。
 */
import { api } from './client'

export interface SkillIndex {
  id: string
  name: string
  description: string
  category: string | null
  source_type: 'manual' | 'promoted'
  created_by: string
  created_at: string
  view_count: number
}

export interface SkillRow extends SkillIndex {
  content: string
  source_ref: string | null
  updated_at: string
  active: number
  last_viewed_at: string | null
}

export interface SkillBinding {
  id: number
  group_id: string
  agent_name: string
  skill_id: string
  skill_name: string | null
  created_by: string
  created_at: string
}

export const skillsApi = {
  async list(category?: string): Promise<SkillIndex[]> {
    const q = category ? `?category=${encodeURIComponent(category)}` : ''
    return api.get<SkillIndex[]>(`/skills${q}`)
  },

  async search(keyword: string): Promise<SkillIndex[]> {
    return api.get<SkillIndex[]>(`/skills/search?q=${encodeURIComponent(keyword)}`)
  },

  async getByName(name: string): Promise<SkillRow> {
    return api.get<SkillRow>(`/skills/${encodeURIComponent(name)}`)
  },

  async create(data: { name: string; description: string; content: string; category?: string; createdBy: string }): Promise<{ id: string; name: string }> {
    return api.post(`/skills`, data)
  },

  async update(name: string, data: Partial<{ name: string; description: string; content: string; category: string | null }>): Promise<{ ok: boolean }> {
    return api.patch(`/skills/${encodeURIComponent(name)}`, data)
  },

  async remove(name: string): Promise<{ ok: boolean }> {
    return api.delete(`/skills/${encodeURIComponent(name)}`)
  },

  // ── 绑定 ────────────────────────────────────────────────────────────
  async listForAgent(groupId: string, agentName: string): Promise<SkillIndex[]> {
    return api.get<SkillIndex[]>(`/groups/${encodeURIComponent(groupId)}/skills/${encodeURIComponent(agentName)}`)
  },

  async bind(groupId: string, agentName: string, skillName: string, createdBy: string): Promise<{ ok: boolean; created: boolean }> {
    return api.post(`/groups/${encodeURIComponent(groupId)}/skills/${encodeURIComponent(agentName)}/bind`, { skillName, createdBy })
  },

  async unbind(groupId: string, agentName: string, skillName: string): Promise<{ ok: boolean; removed: boolean }> {
    return api.delete(`/groups/${encodeURIComponent(groupId)}/skills/${encodeURIComponent(agentName)}/bind/${encodeURIComponent(skillName)}`)
  },

  async listBindings(groupId: string): Promise<SkillBinding[]> {
    return api.get<SkillBinding[]>(`/groups/${encodeURIComponent(groupId)}/skill-bindings`)
  },

  async listAllBindings(opts: { groupId?: string; agentName?: string } = {}): Promise<SkillBinding[]> {
    const qs = new URLSearchParams()
    if (opts.groupId) qs.set('groupId', opts.groupId)
    if (opts.agentName) qs.set('agentName', opts.agentName)
    const q = qs.toString()
    return api.get<SkillBinding[]>(`/skills/bindings/all${q ? `?${q}` : ''}`)
  },

  // ── playbook memory → skill ──────────────────────────────────────────
  async promoteMemory(memoryId: string, opts: { name?: string; description?: string; createdBy: string }): Promise<{ skillId: string; name: string }> {
    return api.post(`/memory/${encodeURIComponent(memoryId)}/promote-to-skill`, opts)
  },
}
