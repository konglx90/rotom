import type { Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Select } from '../../components/ui/Select'
import styles from './FilterBar.module.css'

interface FilterBarProps {
  filter: 'all' | 'online'
  onFilterChange: (filter: 'all' | 'online') => void
  searchQuery: string
  onSearchChange: (query: string) => void
  domains: Domain[]
  selectedDomain: string
  onSelectDomain: (name: string) => void
  onAddDomain?: () => void
  onEditDomain?: (domain: Domain) => void
  onDeleteDomain?: (domain: Domain) => void
  onSelectRules?: () => void
  isRulesView?: boolean
  viewMode: 'table' | 'topology'
  onViewModeChange: (mode: 'table' | 'topology') => void
  onAddAgent?: () => void
}

export function FilterBar({
  filter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  domains,
  selectedDomain,
  onSelectDomain,
  onAddDomain,
  onEditDomain,
  onDeleteDomain,
  onSelectRules,
  isRulesView,
  viewMode,
  onViewModeChange,
  onAddAgent,
}: FilterBarProps) {
  const sortedDomains = [...domains].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  return (
    <div className={styles.container}>
      {/* Status Filters */}
      <div className={styles.group}>
        <button
          className={`${styles.chip} ${filter === 'all' ? styles.active : ''}`}
          onClick={() => onFilterChange('all')}
        >
          全部
        </button>
        <button
          className={`${styles.chip} ${filter === 'online' ? styles.active : ''}`}
          onClick={() => onFilterChange('online')}
        >
          在线
        </button>
      </div>

      {/* Domain Filter — 合并原 DepartmentTree 的部门筛选与跨域规则入口 */}
      <div className={styles.group}>
        <div className={styles.domainSelectWrapper}>
          <Select
            className={styles.domainSelect}
            value={isRulesView ? '__rules__' : selectedDomain}
            onChange={(e) => {
              const val = e.target.value
              if (val === '__rules__') {
                onSelectRules?.()
              } else {
                onSelectDomain(val)
              }
            }}
          >
            <option value="all">👥 全部部门</option>
            {sortedDomains.map((d) => (
              <option key={d.id} value={d.name}>
                🏢 {d.name} ({d.agentCount ?? 0})
              </option>
            ))}
            <option disabled>──────────</option>
            <option value="__rules__">🔗 跨域规则</option>
          </Select>

          {/* 添加部门按钮 */}
          {!isRulesView && onAddDomain && (
            <button
              type="button"
              className={styles.domainActionBtn}
              onClick={onAddDomain}
              title="添加部门"
              aria-label="添加部门"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 3a1 1 0 011 1v3h3a1 1 0 110 2H9v3a1 1 0 11-2 0V9H4a1 1 0 110-2h3V4a1 1 0 011-1z" />
              </svg>
            </button>
          )}

          {/* 编辑当前部门按钮 */}
          {!isRulesView && selectedDomain !== 'all' && onEditDomain && (() => {
            const d = sortedDomains.find((d) => d.name === selectedDomain)
            return d ? (
              <button
                type="button"
                className={styles.domainActionBtn}
                onClick={() => onEditDomain(d)}
                title="编辑部门名称"
                aria-label="编辑部门"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M12.146 1.146a.5.5 0 01.708 0l2 2a.5.5 0 010 .708l-9.5 9.5a.5.5 0 01-.168.11l-4 1.5a.5.5 0 01-.65-.65l1.5-4a.5.5 0 01.11-.168l9.5-9.5zM11.207 3L13 4.793 14.293 3.5 12.5 1.707 11.207 3z" />
                </svg>
              </button>
            ) : null
          })()}

          {/* 删除当前部门按钮 */}
          {!isRulesView && selectedDomain !== 'all' && onDeleteDomain && (() => {
            const d = sortedDomains.find((d) => d.name === selectedDomain)
            return d ? (
              <button
                type="button"
                className={`${styles.domainActionBtn} ${styles.domainActionDanger}`}
                onClick={() => onDeleteDomain(d)}
                title="删除当前部门"
                aria-label="删除部门"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 011 0v6a.5.5 0 01-1 0V6zM14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6V1.5A.5.5 0 016.5 1h3a.5.5 0 01.5.5V2h3.5a1 1 0 011 1zM4 4v9a1 1 0 001 1h6a1 1 0 001-1V4H4z" />
                </svg>
              </button>
            ) : null
          })()}
        </div>
      </div>

      {/* Search */}
      <div className={styles.group}>
        <Input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索员工..."
          className={styles.search}
        />
      </div>

      {/* View Toggle */}
      <div className={styles.group}>
        <button
          className={`${styles.viewBtn} ${viewMode === 'table' ? styles.active : ''}`}
          onClick={() => onViewModeChange('table')}
          title="表格视图"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 3h16v2H0V3zm0 4h16v2H0V7zm0 4h16v2H0v-2z"/>
          </svg>
        </button>
        <button
          className={`${styles.viewBtn} ${viewMode === 'topology' ? styles.active : ''}`}
          onClick={() => onViewModeChange('topology')}
          title="拓扑视图"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="4" r="2"/>
            <circle cx="3" cy="12" r="2"/>
            <circle cx="13" cy="12" r="2"/>
            <path d="M8 6v3M4.5 10.5l2.5-2.5M8.5 8l2.5 2.5" stroke="currentColor" strokeWidth="1" fill="none"/>
          </svg>
        </button>
      </div>

      {/* Add Agent Button */}
      {onAddAgent && (
        <div className={styles.group}>
          <Button
            variant="primary"
            size="sm"
            onClick={onAddAgent}
            title="添加员工"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="5" r="2.5"/>
              <path d="M1.5 13.5c0-2.2 2-4 4.5-4s4.5 1.8 4.5 4"/>
              <line x1="13" y1="5" x2="13" y2="9"/>
              <line x1="11" y1="7" x2="15" y2="7"/>
            </svg>
            添加员工
          </Button>
        </div>
      )}
    </div>
  )
}
