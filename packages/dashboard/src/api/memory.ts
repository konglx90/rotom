/**
 * Memory API client — agent_memory 表(memory + note 统一载体)。
 *
 * note = agent_visible=0(纯人看,agent 搜不到)
 * memory = agent_visible=1(agent 可见,走 search/注入)
 */
import { api } from './client'

export type MemoryCategory = 'fact' | 'decision' | 'convention' | 'pitfall' | 'todo' | 'playbook' | 'note'
export type MemoryScope = 'group' | 'global'
export type MemoryVisibility = 'private' | 'group' | 'global'

export interface MemoryIndex {
  id: string
  key: string
  summary: string | null
  tags: string
  category: MemoryCategory
  scope: MemoryScope
  group_id: string | null
  agent_visible: number
  created_by: string | null
  created_at: string
}

export interface MemoryRow extends MemoryIndex {
  value: string
  source_type: 'manual' | 'issue_summary'
  source_ref: string | null
  visibility: MemoryVisibility
  updated_at: string
  expires_at: string | null
  active: number
  pending_review: number
  injected_count: number
  view_count: number
  last_viewed_at: string | null
}

export interface MemoryInput {
  key: string
  value: string
  category: MemoryCategory
  summary?: string
  tags?: string[]
  visibility?: MemoryVisibility
  agentVisible?: boolean
  createdBy: string
  expiresAt?: string | null
}

export interface MemoryStats {
  total: number
  active: number
  pending: number
  byCategory: Record<string, number>
  byAgentVisible: { note: number; memory: number }
  topViewed: MemoryIndex[]
}

export const memoryApi = {
  // ── list ────────────────────────────────────────────────────────────
  async listGroup(groupId: string, opts: { type?: 'note' | 'memory' | 'all'; category?: MemoryCategory; includePending?: boolean } = {}): Promise<MemoryIndex[]> {
    const qs = new URLSearchParams()
    if (opts.type && opts.type !== 'all') qs.set('type', opts.type)
    if (opts.category) qs.set('category', opts.category)
    if (opts.includePending) qs.set('includePending', 'true')
    const q = qs.toString()
    return api.get<MemoryIndex[]>(`/groups/${groupId}/memory${q ? `?${q}` : ''}`)
  },

  async listGlobal(opts: { type?: 'note' | 'memory' | 'all'; category?: MemoryCategory; includePending?: boolean } = {}): Promise<MemoryIndex[]> {
    const qs = new URLSearchParams()
    if (opts.type && opts.type !== 'all') qs.set('type', opts.type)
    if (opts.category) qs.set('category', opts.category)
    if (opts.includePending) qs.set('includePending', 'true')
    const q = qs.toString()
    return api.get<MemoryIndex[]>(`/memory/global${q ? `?${q}` : ''}`)
  },

  // ── search(强制 agent_visible=1)─────────────────────────────────────
  async search(keyword: string, groupId?: string): Promise<{ group: MemoryIndex[]; global: MemoryIndex[] }> {
    if (groupId) {
      return api.get(`/groups/${groupId}/memory/search?q=${encodeURIComponent(keyword)}`)
    }
    const rows = await api.get<MemoryIndex[]>(`/memory/search?q=${encodeURIComponent(keyword)}`)
    return { group: [], global: rows }
  },

  // ── 详情 ─────────────────────────────────────────────────────────────
  async getById(id: string): Promise<MemoryRow> {
    return api.get<MemoryRow>(`/memory/${id}`)
  },

  // ── 新建 ─────────────────────────────────────────────────────────────
  async createGroup(groupId: string, data: MemoryInput): Promise<{ id: string }> {
    return api.post(`/groups/${groupId}/memory`, data)
  },

  async createGlobal(data: MemoryInput): Promise<{ id: string }> {
    return api.post(`/memory/global`, data)
  },

  // ── 更新 ─────────────────────────────────────────────────────────────
  async update(id: string, data: Partial<{ value: string; summary: string; tags: string[]; category: MemoryCategory; visibility: MemoryVisibility; agentVisible: boolean; expiresAt: string | null }>): Promise<{ ok: boolean }> {
    return api.patch(`/memory/${id}`, data)
  },

  async remove(id: string): Promise<{ ok: boolean }> {
    return api.delete(`/memory/${id}`)
  },

  async promote(id: string, visibility: MemoryVisibility): Promise<{ ok: boolean }> {
    return api.post(`/memory/${id}/promote`, { visibility })
  },

  async expire(id: string): Promise<{ ok: boolean }> {
    return api.post(`/memory/${id}/expire`)
  },

  // ── 审核 ─────────────────────────────────────────────────────────────
  async listPending(groupId: string): Promise<MemoryIndex[]> {
    return api.get(`/groups/${groupId}/memory/pending`)
  },

  async approve(id: string): Promise<{ ok: boolean }> {
    return api.post(`/memory/${id}/approve`)
  },

  async reject(id: string): Promise<{ ok: boolean }> {
    return api.post(`/memory/${id}/reject`)
  },

  // ── 统计 ─────────────────────────────────────────────────────────────
  async stats(groupId: string): Promise<MemoryStats> {
    return api.get(`/groups/${groupId}/memory/stats`)
  },

  async count(groupId: string): Promise<{ group: number; global: number }> {
    return api.get(`/groups/${groupId}/memory/count`)
  },
}
