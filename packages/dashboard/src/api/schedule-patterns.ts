import { api } from './client'
import type { SchedulePattern } from './types'

/**
 * Schedule Patterns API client — 调度模式参考库。
 * 供工具箱「定时任务模板管理」Tab 使用。
 */
export const schedulePatternsApi = {
  async list(): Promise<SchedulePattern[]> {
    return api.get<SchedulePattern[]>('/schedule-patterns')
  },

  async create(body: {
    name: string
    description?: string
    schedule_config?: string | null
    sort_order?: number
  }): Promise<SchedulePattern> {
    return api.post<SchedulePattern>('/schedule-patterns', body)
  },

  async update(id: number, patch: {
    name?: string
    description?: string
    schedule_config?: string | null
    sort_order?: number
  }): Promise<SchedulePattern> {
    return api.patch<SchedulePattern>(`/schedule-patterns/${id}`, patch)
  },

  async remove(id: number): Promise<void> {
    await api.delete<{ ok: boolean }>(`/schedule-patterns/${id}`)
  },
}
