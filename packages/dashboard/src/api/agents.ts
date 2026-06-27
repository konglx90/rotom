import { api } from './client'
import type {
  Agent,
  CreateAgentDto,
  UpdateAgentDto,
} from './types'

/**
 * Agents API
 */
export const agentsApi = {
  /**
   * List all agents
   */
  async list(): Promise<Agent[]> {
    return api.get<Agent[]>('/agents')
  },

  /**
   * List online agents only
   */
  async listOnline(): Promise<Array<{ name: string; domain?: string }>> {
    return api.get<Array<{ name: string; domain?: string }>>('/agents/online')
  },

  /**
   * Get agent by ID
   */
  async getById(id: string): Promise<Agent> {
    return api.get<Agent>(`/agents/${id}`)
  },

  /**
   * Create a new agent
   */
  async create(data: CreateAgentDto): Promise<Agent & { token: string; configTemplate?: unknown }> {
    return api.post<Agent & { token: string; configTemplate?: unknown }>('/agents', data)
  },

  /**
   * Update agent
   */
  async update(id: string, data: UpdateAgentDto): Promise<{ ok: boolean }> {
    return api.put<{ ok: boolean }>(`/agents/${id}`, data)
  },

  /**
   * Delete agent
   */
  async delete(id: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/agents/${id}`)
  },

  /**
   * Refresh agent token
   */
  async refreshToken(id: string): Promise<{ token: string }> {
    return api.post<{ token: string }>(`/agents/${id}/refresh-token`)
  },

  /**
   * Upload avatar for an agent
   */
  async uploadAvatar(agentId: string, dataBase64: string, mimeType: string): Promise<{ url: string }> {
    return api.post<{ url: string }>('/agents/avatar', { agentId, dataBase64, mimeType })
  },

  /**
   * Send message to an agent
   */
  async sendMessage(from: string, to: string, message: string): Promise<{
    requestId: string
    delivered: boolean
    queued: boolean
    message: string
  }> {
    return api.post('/messages/send', { from, to, message })
  },
}
