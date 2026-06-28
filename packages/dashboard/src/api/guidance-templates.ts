import { api } from './client'
import type { GuidanceTemplate } from './types'

/**
 * Guidance Templates API client — 群指导 prompt 模板库。
 * 用于 MemberListModal / GroupSettingsModal 的「📚 从模板选择」按钮。
 */
export const guidanceTemplatesApi = {
  async list(): Promise<GuidanceTemplate[]> {
    return api.get<GuidanceTemplate[]>('/guidance-templates')
  },

  async create(body: {
    name: string
    description?: string
    prompt_text: string
    schedule_config?: string | null
    sort_order?: number
  }): Promise<GuidanceTemplate> {
    return api.post<GuidanceTemplate>('/guidance-templates', body)
  },

  async update(id: number, patch: {
    name?: string
    description?: string
    prompt_text?: string
    schedule_config?: string | null
    sort_order?: number
  }): Promise<GuidanceTemplate> {
    return api.patch<GuidanceTemplate>(`/guidance-templates/${id}`, patch)
  },

  async remove(id: number): Promise<void> {
    await api.delete<{ ok: boolean }>(`/guidance-templates/${id}`)
  },
}
