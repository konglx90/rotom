import { api } from './client'
import type { Schedule } from './types'

/**
 * Schedules API client — 列表 + 新建。
 * 修改/删除/启停仍可走 `rotom schedule ...` CLI;新建主要服务于「群指导模板」
 * 选模板时一并创建定时任务的场景。
 */
export interface CreateScheduleBody {
  name: string
  group_id: string
  mode: 'agent' | 'message'
  agent_name?: string
  schedule_kind: 'once' | 'interval'
  interval_sec?: number
  run_at?: number
  prompt: string
  repeat_times?: number | null
  enabled?: boolean
}

export const schedulesApi = {
  async listByGroup(groupId: string): Promise<Schedule[]> {
    return api.get<Schedule[]>(`/schedules?group_id=${encodeURIComponent(groupId)}`)
  },

  async create(body: CreateScheduleBody): Promise<Schedule> {
    return api.post<Schedule>('/schedules', body)
  },
}
