import { Button } from '../../components/ui/Button'
import { useReadOnly, READ_ONLY_TITLE } from '../../hooks/useReadOnly'
import styles from './FilterBar.module.css'

interface FilterBarProps {
  filter: 'all' | 'online'
  onFilterChange: (filter: 'all' | 'online') => void
  searchQuery: string
  onSearchChange: (query: string) => void
  viewMode: 'table' | 'topology'
  onViewModeChange: (mode: 'table' | 'topology') => void
  onAddAgent?: () => void
}

export function FilterBar({
  filter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  viewMode,
  onViewModeChange,
  onAddAgent,
}: FilterBarProps) {
  const readOnly = useReadOnly()
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

      {/* Search */}
      <div className={styles.group}>
        <input
          type="text"
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
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TITLE : '添加员工'}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 100 16A8 8 0 000-16zM4 8a1 1 0 011-1h2V5a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 010-2zm4 0a1 1 0 011 1v2a1 1 0 01-1 1H8a1 1 0 010-2zm3 1a1 1 0 100-2 1 1 0 000 2z"/>
            </svg>
            添加员工
          </Button>
        </div>
      )}
    </div>
  )
}
