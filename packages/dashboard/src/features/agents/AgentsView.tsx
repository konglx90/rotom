import { useEffect, useState } from 'react'
import { agentsApi } from '../../api/agents'
import { domainsApi } from '../../api/domains'
import type { Agent, Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { AsyncBoundary } from '../../components/data/AsyncBoundary'
import { useAgentsWithFilters } from '../../hooks/useAgents'
import { FilterBar } from './FilterBar'
import { StatsCards } from './StatsCards'
import { AgentTable } from './AgentTable'
import { TopologyView } from './TopologyView'
import { AddAgentModal } from './AddAgentModal'
import { AgentProfileModal } from './AgentProfileModal'
import { DepartmentFormModal } from './DepartmentFormModal'
import { CrossDomainRulesPanel } from './CrossDomainRulesPanel'
import { BrandFooter } from './BrandFooter'
import styles from './AgentsView.module.css'

type RightView = 'employees' | 'rules'

export function AgentsView() {
  const result = useAgentsWithFilters()
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

  return (
    <AsyncBoundary
      data={result.agents}
      loading={result.loading}
      error={result.error}
      onRetry={result.refetch}
      loadingFallback={
        <div className={styles.loading}>
          <div className={styles.spinner}></div>
          <p>加载员工数据...</p>
        </div>
      }
      errorFallback={(err, retry) => (
        <div className={styles.error}>
          <p>❌ 加载失败: {typeof err === 'string' ? err : err.message}</p>
          <Button variant="ghost" size="sm" onClick={retry}>重试</Button>
        </div>
      )}
    >
      {() => (
        <AgentsViewBody
          result={result}
          viewMode={viewMode}
          setViewMode={setViewMode}
          showAddModal={showAddModal}
          setShowAddModal={setShowAddModal}
          profileAgent={profileAgent}
          setProfileAgent={setProfileAgent}
          allDomains={allDomains}
          fetchDomains={fetchDomains}
          rightView={rightView}
          setRightView={setRightView}
          deptModal={deptModal}
          setDeptModal={setDeptModal}
        />
      )}
    </AsyncBoundary>
  )
}

interface AgentsViewBodyProps {
  result: ReturnType<typeof useAgentsWithFilters>
  viewMode: 'table' | 'topology'
  setViewMode: (m: 'table' | 'topology') => void
  showAddModal: boolean
  setShowAddModal: (v: boolean) => void
  profileAgent: Agent | null
  setProfileAgent: (a: Agent | null) => void
  allDomains: Domain[]
  fetchDomains: () => Promise<void>
  rightView: RightView
  setRightView: (v: RightView) => void
  deptModal:
    | { open: false }
    | { open: true; mode: 'create' }
    | { open: true; mode: 'edit'; domain: Domain }
  setDeptModal: (s:
    | { open: false }
    | { open: true; mode: 'create' }
    | { open: true; mode: 'edit'; domain: Domain }) => void
}

function AgentsViewBody({
  result,
  viewMode,
  setViewMode,
  showAddModal,
  setShowAddModal,
  profileAgent,
  setProfileAgent,
  allDomains,
  fetchDomains,
  rightView,
  setRightView,
  deptModal,
  setDeptModal,
}: AgentsViewBodyProps) {
  const { agents, allAgents, refetch, filters, filteredAgents } = result

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

  const defaultDomainForAdd =
    filters.domainFilter !== 'all' && filters.domainFilter ? filters.domainFilter : undefined

  return (
    <div className={styles.layout}>
      <div className={styles.content}>
        {/* 过滤栏：状态 / 部门 / 搜索 / 视图切换 / 添加员工 — 部门管理与跨域规则也整合在此 */}
        <FilterBar
          filter={filters.filter}
          onFilterChange={filters.setFilter}
          searchQuery={filters.searchQuery}
          onSearchChange={filters.setSearchQuery}
          domains={allDomains}
          selectedDomain={filters.domainFilter}
          onSelectDomain={(name) => name === 'all' ? handleSelectAll() : handleSelectDomain(name)}
          onAddDomain={() => setDeptModal({ open: true, mode: 'create' })}
          onEditDomain={(domain) => setDeptModal({ open: true, mode: 'edit', domain })}
          onDeleteDomain={handleDeleteDomain}
          onSelectRules={handleSelectRules}
          isRulesView={rightView === 'rules'}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onAddAgent={() => setShowAddModal(true)}
        />

        {rightView === 'employees' ? (
          <div className={styles.container}>
            <StatsCards agents={allAgents} />

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

        <BrandFooter />
      </div>

      <AddAgentModal
        open={showAddModal}
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
        open={!!profileAgent}
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
