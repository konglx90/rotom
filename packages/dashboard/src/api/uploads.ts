import { api } from './client'

/**
 * 图册(uploads)API client — 工具箱图册 tab 用。
 *
 * 后端把图片存到 ~/.rotom/uploads/<YYYY-MM>/<groupId>/<文件>,无 DB 索引表,
 * 列表接口实时扫盘。详见 src/master/api/uploads.ts。
 */

export interface UploadItem {
  url: string
  groupId: string
  groupName: string
  fileName: string
  mimeType: string
  size: number
  createdAt: string // ISO 8601 UTC
}

export interface UploadListResponse {
  items: UploadItem[]
  nextCursor: string | null
}

export const uploadsApi = {
  async list(opts?: {
    groupId?: string
    limit?: number
    cursor?: string
  }): Promise<UploadListResponse> {
    const params = new URLSearchParams()
    if (opts?.groupId) params.set('groupId', opts.groupId)
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    return api.get<UploadListResponse>(`/uploads${qs ? `?${qs}` : ''}`)
  },
}
