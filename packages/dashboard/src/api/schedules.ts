import { api } from './client'
import type { Schedule } from './types'

/**
 * Schedules API client — 当前只暴露只读列表。
 * 新建/修改/删除走 `rotom schedule ...` CLI,避免在 Dashboard 里再造一套表单。
 */
export const schedulesApi = {
  async listByGroup(groupId: string): Promise<Schedule[]> {
    return api.get<Schedule[]>(`/schedules?group_id=${encodeURIComponent(groupId)}`)
  },
}