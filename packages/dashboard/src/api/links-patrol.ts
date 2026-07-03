import { api } from './client'

/**
 * Link 智能分类 API client — 工具箱 Link 分类 tab 用。
 */

export interface LinkPatrolState {
  hasPatrolGroup: boolean
  patrolGroupId?: string
  patrolGroupName?: string
  patrolAgentName?: string
  taskId?: number
  enabled: boolean
  intervalSec?: number
  nextRunAt?: number
  lastRunAt?: number | null
  lastStatus?: string | null
  lastError?: string | null
  scanBatch?: number
}

export interface LinkPatrolConfigPatch {
  enabled?: boolean
  intervalSec?: number
  scanBatch?: number
}

export interface LinkPatrolRun {
  run_id: string
  patrol_group_id: string
  patrol_issue_id: string | null
  started_at: string
  finished_at: string | null
  candidates_scanned: number
  candidates_classified: number
  status: 'dispatched' | 'completed' | 'skipped' | 'agent_offline' | 'error'
  note: string | null
}

export interface LinkPatrolLog {
  id: string
  run_id: string
  link_id: string | null
  category: string
  tags: string | null
  title: string | null
  rationale: string | null
  raw: string | null
  created_at: string
}

export interface LinkPatrolStats {
  totalLinks: number
  unclassified: number
  totalOccurrences: number
  classifiedHosts: number
  lastRun: {
    run_id: string
    started_at: string
    finished_at: string | null
    status: string
    candidates_scanned: number
    candidates_classified: number
    note: string | null
  } | null
}

export interface LinkItem {
  id: string
  url_norm: string
  url_raw: string
  title: string | null
  category: string | null
  summary: string | null
  host: string
  created_at: string
  updated_at: string
  last_seen_at: string
}

export interface LinkDetail extends LinkItem {
  tags: string[]
  occurrences: Array<{
    id: string
    link_id: string
    source_type: string
    source_id: string | null
    source_group_id: string | null
    source_sender: string | null
    context_snippet: string | null
    occurred_at: string
  }>
  source_groups: string[]
}

export const linksPatrolApi = {
  async state(): Promise<LinkPatrolState> {
    return api.get<LinkPatrolState>('/links-patrol/state')
  },

  async updateConfig(patch: LinkPatrolConfigPatch): Promise<{
    ok: boolean
    enabled: boolean
    intervalSec: number
    scanBatch: number
    nextRunAt: number
  }> {
    return api.patch('/links-patrol/config', patch)
  },

  async stats(): Promise<LinkPatrolStats> {
    return api.get<LinkPatrolStats>('/links-patrol/stats')
  },

  async listRuns(limit = 50): Promise<LinkPatrolRun[]> {
    const res = await api.get<{ runs: LinkPatrolRun[] }>(`/links-patrol/runs?limit=${limit}`)
    return res.runs
  },

  async listRunLogs(runId: string): Promise<LinkPatrolLog[]> {
    const res = await api.get<{ logs: LinkPatrolLog[] }>(`/links-patrol/runs/${encodeURIComponent(runId)}/logs`)
    return res.logs
  },

  async listLinks(params?: { category?: string; tag?: string; search?: string; groupId?: string; host?: string; limit?: number; offset?: number }): Promise<{ items: LinkItem[]; total: number }> {
    const search = new URLSearchParams()
    if (params?.category) search.set('category', params.category)
    if (params?.tag) search.set('tag', params.tag)
    if (params?.search) search.set('search', params.search)
    if (params?.groupId) search.set('group_id', params.groupId)
    if (params?.host) search.set('host', params.host)
    if (params?.limit) search.set('limit', String(params.limit))
    if (params?.offset) search.set('offset', String(params.offset))
    const qs = search.toString()
    return api.get<{ items: LinkItem[]; total: number }>(`/links${qs ? `?${qs}` : ''}`)
  },

  async getLink(id: string): Promise<LinkDetail> {
    return api.get<LinkDetail>(`/links/${encodeURIComponent(id)}`)
  },

  async updateLink(id: string, patch: { category?: string; tags?: string[]; title?: string; summary?: string }): Promise<{ ok: boolean; link: LinkItem }> {
    return api.patch(`/links/${encodeURIComponent(id)}`, patch)
  },

  async trigger(taskId: number): Promise<{ ok: boolean; next_run_at: number }> {
    return api.post(`/schedules/${taskId}/trigger`)
  },
}
