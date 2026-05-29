import { useState } from 'react'
import { useChatContext } from '../context/ChatContext'
import type { Agent } from '../api/types'

export type { Agent }

export function useAgents() {
  const { agents, agentsLoading, agentsError, loadAgents } = useChatContext()
  return {
    agents,
    loading: agentsLoading,
    error: agentsError,
    refetch: () => loadAgents(true),
  }
}

export function useAgentsWithFilters() {
  const { agents, loading, error, refetch } = useAgents()
  const [filter, setFilter] = useState<'all' | 'online'>('all')
  const [domainFilter, setDomainFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredAgents = agents.filter((agent) => {
    // Status filter
    if (filter === 'online' && agent.status !== 'online') return false

    // Domain filter
    if (domainFilter !== 'all' && agent.domain !== domainFilter) return false

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      return (
        agent.name.toLowerCase().includes(query) ||
        agent.description?.toLowerCase().includes(query) ||
        agent.domain?.toLowerCase().includes(query)
      )
    }

    return true
  })

  const domains = [...new Set(agents.map(a => a.domain).filter(Boolean))].sort()

  return {
    agents: filteredAgents,
    filteredAgents,
    allAgents: agents,
    loading,
    error,
    refetch,
    filters: {
      filter,
      setFilter,
      domainFilter,
      setDomainFilter,
      searchQuery,
      setSearchQuery,
    },
    domains,
  }
}
