import { api } from './client'
import type {
  MessageListResponse,
  AuditEvent,
  Stats,
  SendMessageDto,
} from './types'

/**
 * Messages API
 */
export const messagesApi = {
  /**
   * List messages with optional filtering
   */
  async list(params?: {
    agent?: string
    from?: string
    to?: string
    status?: string
    keyword?: string
    groupId?: string
    limit?: number
    offset?: number
    before?: string
  }): Promise<MessageListResponse> {
    const searchParams = new URLSearchParams()
    if (params?.agent) searchParams.set('agent', params.agent)
    if (params?.from) searchParams.set('from', params.from)
    if (params?.to) searchParams.set('to', params.to)
    if (params?.status) searchParams.set('status', params.status)
    if (params?.keyword) searchParams.set('keyword', params.keyword)
    if (params?.groupId) searchParams.set('groupId', params.groupId)
    if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
    if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))
    if (params?.before) searchParams.set('before', params.before)

    const query = searchParams.toString()
    return api.get<MessageListResponse>(`/messages${query ? `?${query}` : ''}`)
  },

  /**
   * Send a message to an agent
   */
  async send(data: SendMessageDto): Promise<{ ok: boolean; requestId: string }> {
    return api.post<{ ok: boolean; requestId: string }>('/messages/send', data)
  },
}

/**
 * Audit Events API
 */
export const auditApi = {
  /**
   * List audit/events
   */
  async list(limit: number = 30): Promise<AuditEvent[]> {
    return api.get<AuditEvent[]>(`/audit?limit=${limit}`)
  },
}

/**
 * Stats API
 */
export const statsApi = {
  /**
   * Get system statistics
   */
  async get(): Promise<Stats> {
    return api.get<Stats>('/stats')
  },
}
