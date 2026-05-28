import { api } from './client'
import type {
  Domain,
  CreateDomainDto,
  UpdateDomainDto,
  CrossDomainRule,
  CreateRuleDto,
} from './types'

/**
 * Domains API
 */
export const domainsApi = {
  /**
   * List all domains with agent counts
   */
  async list(): Promise<Domain[]> {
    return api.get<Domain[]>('/domains')
  },

  /**
   * Create a new domain
   */
  async create(data: CreateDomainDto): Promise<Domain> {
    return api.post<Domain>('/domains', data)
  },

  /**
   * Update domain
   */
  async update(id: string, data: UpdateDomainDto): Promise<{ ok: boolean }> {
    return api.put<{ ok: boolean }>(`/domains/${id}`, data)
  },

  /**
   * Delete domain
   */
  async delete(id: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/domains/${id}`)
  },
}

/**
 * Cross-Domain Rules API
 */
export const rulesApi = {
  /**
   * List all cross-domain rules
   */
  async list(): Promise<{ rules: CrossDomainRule[]; domains: string[] }> {
    return api.get<{ rules: CrossDomainRule[]; domains: string[] }>('/cross-domain')
  },

  /**
   * Create a new rule
   */
  async create(data: CreateRuleDto): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>('/cross-domain', data)
  },

  /**
   * Delete a rule
   */
  async delete(from: string, to: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/cross-domain?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
  },
}
