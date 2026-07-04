import type { Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
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
  domains: _domains,
  selectedDomain: _selectedDomain,
  onSelectDomain: _onSelectDomain,
  onAddDomain: _onAddDomain,
  onEditDomain: _onEditDomain,
  onDeleteDomain: _onDeleteDomain,
  onSelectRules: _onSelectRules,
  isRulesView: _isRulesView,
  viewMode,
  onViewModeChange,
  onAddAgent,
}: FilterBarProps) {
  // 老的 Domain 分组筛选已移除 — 新模型下 agents 页只看本机 agent。
  // domain 相关 props 保留(向后兼容 AgentsView 调用),但不再使用。

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

      {/* 老的 Domain 分组筛选已移除 — 新模型下 agents 页只看本机 agent,
          跨机协作走 federation team(见 sidebar「团队」)。domain 字段仍在 DB,
          但 UI 不再展示筛选。如需跨域权限,在 toolbox 里单独配置。 */}

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
