import { useEffect, useState } from 'react'
import { agentsApi } from '../../api/agents'
import { domainsApi } from '../../api/domains'
import type { Agent, Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { useAgentsWithFilters } from '../../hooks/useAgents'
import { FilterBar } from './FilterBar'
import { StatsCards } from './StatsCards'
import { AgentTable } from './AgentTable'
import { TopologyView } from './TopologyView'
import { AddAgentModal } from './AddAgentModal'
import { AgentProfileModal } from './AgentProfileModal'
import { DepartmentTree } from './DepartmentTree'
import { DepartmentFormModal } from './DepartmentFormModal'
import { CrossDomainRulesPanel } from './CrossDomainRulesPanel'
import styles from './AgentsView.module.css'

type RightView = 'employees' | 'rules'

export function AgentsView() {
  const { agents, allAgents, loading, error, refetch, filters, filteredAgents } = useAgentsWithFilters()
  const [viewMode, setViewMode] = useState<'table' | 'topology'>('table')
  const [showAddModal, setShowAddModal] = useState(false)
  const [profileAgent, setProfileAgent] = useState<Agent | null>(null)
  const [allDomains, setAllDomains] = useState<Domain[]>([])
  const [rightView, setRightView] = useState<RightView>('employees')
  const [deptModal, setDeptModal] = useState<
    | { open: false }
    | { open: true; mode: 'create' }
    | { open: true; mode: 'edit'; domain: Domain }
  >({ open: false })

  const fetchDomains = async () => {
    try {
      const list = await domainsApi.list()
      setAllDomains(list)
    } catch {
      // ignore — modal will fall back to derived domains
    }
  }

  useEffect(() => {
    fetchDomains()
  }, [])

  const handleDelete = async (agent: Agent) => {
    if (!window.confirm(`确定要删除 ${agent.name} 吗？此操作不可恢复。`)) return
    try {
      const res = await agentsApi.delete(agent.id)
      if ('error' in res) {
        alert('删除失败: ' + (res as any).error)
      } else {
        refetch()
        fetchDomains()
      }
    } catch {
      alert('删除失败，请重试')
    }
  }

  const handleDeleteDomain = async (domain: Domain) => {
    if (!window.confirm(`确定删除部门「${domain.name}」吗？`)) return
    try {
      await domainsApi.delete(domain.id)
      if (filters.domainFilter === domain.name) {
        filters.setDomainFilter('all')
      }
      fetchDomains()
      refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除部门失败'
      alert(message)
    }
  }

  const handleSelectDomain = (name: string) => {
    setRightView('employees')
    filters.setDomainFilter(name)
  }

  const handleSelectAll = () => {
    setRightView('employees')
    filters.setDomainFilter('all')
  }

  const handleSelectRules = () => {
    setRightView('rules')
  }

  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner}></div>
        <p>加载员工数据...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.error}>
        <p>❌ 加载失败: {error}</p>
        <Button variant="ghost" size="sm" onClick={refetch}>重试</Button>
      </div>
    )
  }

  const defaultDomainForAdd =
    filters.domainFilter !== 'all' && filters.domainFilter ? filters.domainFilter : undefined

  return (
    <div className={styles.layout}>
      <DepartmentTree
        domains={allDomains}
        totalAgentCount={allAgents.length}
        selectedDomain={filters.domainFilter}
        view={rightView}
        onSelectAll={handleSelectAll}
        onSelectDomain={handleSelectDomain}
        onSelectRules={handleSelectRules}
        onAddDomain={() => setDeptModal({ open: true, mode: 'create' })}
        onEditDomain={(domain) => setDeptModal({ open: true, mode: 'edit', domain })}
        onDeleteDomain={handleDeleteDomain}
      />

      <div className={styles.content}>
        {rightView === 'employees' ? (
          <div className={styles.container}>
            <StatsCards agents={allAgents} />

            <FilterBar
              filter={filters.filter}
              onFilterChange={filters.setFilter}
              searchQuery={filters.searchQuery}
              onSearchChange={filters.setSearchQuery}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onAddAgent={() => setShowAddModal(true)}
            />

            {viewMode === 'table' ? (
              <>
                <AgentTable agents={agents} onDelete={handleDelete} onEditProfile={setProfileAgent} />
                {agents.length === 0 && (
                  <div className={styles.empty}>
                    <p>没有找到匹配的员工</p>
                    <p className={styles.hint}>请调整筛选条件</p>
                  </div>
                )}
              </>
            ) : (
              <TopologyView
                agents={filteredAgents}
                statusFilter={filters.filter}
                domainFilter={filters.domainFilter}
              />
            )}
          </div>
        ) : (
          <CrossDomainRulesPanel domains={allDomains} />
        )}
      </div>

      <AddAgentModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        domains={allDomains}
        defaultDomain={defaultDomainForAdd}
        onSuccess={() => {
          refetch()
          fetchDomains()
        }}
      />

      <AgentProfileModal
        agent={profileAgent}
        isOpen={!!profileAgent}
        onClose={() => setProfileAgent(null)}
        onSuccess={refetch}
      />

      <DepartmentFormModal
        open={deptModal.open}
        mode={deptModal.open ? deptModal.mode : 'create'}
        domain={deptModal.open && deptModal.mode === 'edit' ? deptModal.domain : null}
        onClose={() => setDeptModal({ open: false })}
        onSuccess={() => {
          fetchDomains()
          refetch()
        }}
      />
    </div>
  )
}
