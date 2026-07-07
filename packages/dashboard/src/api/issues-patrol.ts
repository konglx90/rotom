import { api } from './client'

/**
 * Issue 巡检 API client — 工具箱 Issue 巡检 tab 用。
 */

export interface PatrolState {
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
  throughputCap?: number
  candidateCap?: number
  scanBatch?: number
}

export interface PatrolConfigPatch {
  enabled?: boolean
  intervalSec?: number
  throughputCap?: number
  candidateCap?: number
  scanBatch?: number
}

export interface PatrolRun {
  run_id: string
  patrol_group_id: string
  patrol_issue_id: string | null
  started_at: string
  finished_at: string | null
  in_progress_count: number
  candidates_scanned: number
  candidates_ready: number
  status: 'dispatched' | 'completed' | 'skipped_quota' | 'skipped_overlap' | 'agent_offline' | 'error'
  note: string | null
}

export interface PatrolLog {
  id: string
  run_id: string
  patrol_group_id: string
  issue_id: string | null
  candidate_group_id: string | null
  verdict: 'ready' | 'not_ready' | 'uncertain' | 'skipped'
  rule_matched: string | null
  rationale: string | null
  raw: string | null
  created_at: string
}

export const issuesPatrolApi = {
  async state(): Promise<PatrolState> {
    return api.get<PatrolState>('/issues-patrol/state')
  },

  async updateConfig(patch: PatrolConfigPatch): Promise<{
    ok: boolean
    enabled: boolean
    intervalSec: number
    throughputCap: number
    candidateCap: number
    scanBatch: number
    nextRunAt: number
  }> {
    return api.patch('/issues-patrol/config', patch)
  },

  async listRuns(opts?: { limit?: number; offset?: number }): Promise<{ runs: PatrolRun[]; total: number }> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return api.get<{ runs: PatrolRun[]; total: number }>(`/issues-patrol/runs${qs ? `?${qs}` : ''}`)
  },

  async listRunLogs(runId: string): Promise<PatrolLog[]> {
    const res = await api.get<{ logs: PatrolLog[] }>(`/issues-patrol/runs/${encodeURIComponent(runId)}/logs`)
    return res.logs
  },

  async listLogs(opts?: { limit?: number; verdict?: string; candidateGroupId?: string }): Promise<PatrolLog[]> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.verdict) params.set('verdict', opts.verdict)
    if (opts?.candidateGroupId) params.set('candidateGroupId', opts.candidateGroupId)
    const qs = params.toString()
    const res = await api.get<{ logs: PatrolLog[] }>(`/issues-patrol/logs${qs ? `?${qs}` : ''}`)
    return res.logs
  },

  async trigger(taskId: number): Promise<{ ok: boolean; next_run_at: number }> {
    return api.post(`/schedules/${taskId}/trigger`)
  },
}
