import type { Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { useReadOnly, READ_ONLY_TITLE } from '../../hooks/useReadOnly'
import styles from './DepartmentTree.module.css'

interface DepartmentTreeProps {
  domains: Domain[]
  totalAgentCount: number
  selectedDomain: string
  view: 'employees' | 'rules'
  onSelectAll: () => void
  onSelectDomain: (name: string) => void
  onSelectRules: () => void
  onAddDomain: () => void
  onEditDomain: (domain: Domain) => void
  onDeleteDomain: (domain: Domain) => void
}

export function DepartmentTree({
  domains,
  totalAgentCount,
  selectedDomain,
  view,
  onSelectAll,
  onSelectDomain,
  onSelectRules,
  onAddDomain,
  onEditDomain,
  onDeleteDomain,
}: DepartmentTreeProps) {
  const readOnly = useReadOnly()
  const sorted = [...domains].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const isAllActive = view === 'employees' && selectedDomain === 'all'
  const isRulesActive = view === 'rules'

  return (
    <aside className={styles.tree}>
      <div className={styles.header}>
        <span className={styles.title}>部门</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          iconOnly
          onClick={onAddDomain}
          disabled={readOnly}
          title={readOnly ? READ_ONLY_TITLE : '添加部门'}
          aria-label="添加部门"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 3a1 1 0 011 1v3h3a1 1 0 110 2H9v3a1 1 0 11-2 0V9H4a1 1 0 110-2h3V4a1 1 0 011-1z" />
          </svg>
        </Button>
      </div>

      <ul className={styles.list}>
        <li>
          <button
            type="button"
            className={`${styles.node} ${isAllActive ? styles.active : ''}`}
            onClick={onSelectAll}
          >
            <span className={styles.nodeIcon}>👥</span>
            <span className={styles.nodeLabel}>全部</span>
            <span className={styles.nodeCount}>{totalAgentCount}</span>
          </button>
        </li>

        {sorted.length === 0 ? (
          <li className={styles.empty}>
            <span>暂无部门</span>
          </li>
        ) : (
          sorted.map((domain) => {
            const isActive = view === 'employees' && selectedDomain === domain.name
            return (
              <li key={domain.id}>
                <div className={`${styles.node} ${isActive ? styles.active : ''}`}>
                  <button
                    type="button"
                    className={styles.nodeMain}
                    onClick={() => onSelectDomain(domain.name)}
                    title={domain.description || domain.name}
                  >
                    <span className={styles.nodeIcon}>🏢</span>
                    <span className={styles.nodeLabel}>{domain.name}</span>
                    <span className={styles.nodeCount}>{domain.agentCount ?? 0}</span>
                  </button>
                  <div className={styles.nodeActions}>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditDomain(domain)
                      }}
                      disabled={readOnly}
                      title={readOnly ? READ_ONLY_TITLE : '重命名'}
                      aria-label="重命名部门"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M12.146 1.146a.5.5 0 01.708 0l2 2a.5.5 0 010 .708l-9.5 9.5a.5.5 0 01-.168.11l-4 1.5a.5.5 0 01-.65-.65l1.5-4a.5.5 0 01.11-.168l9.5-9.5zM11.207 3L13 4.793 14.293 3.5 12.5 1.707 11.207 3z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.danger}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteDomain(domain)
                      }}
                      disabled={readOnly}
                      title={readOnly ? READ_ONLY_TITLE : '删除部门'}
                      aria-label="删除部门"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 011 0v6a.5.5 0 01-1 0V6zM14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 010-2H6V1.5A.5.5 0 016.5 1h3a.5.5 0 01.5.5V2h3.5a1 1 0 011 1zM4 4v9a1 1 0 001 1h6a1 1 0 001-1V4H4z" />
                      </svg>
                    </button>
                  </div>
                </div>
              </li>
            )
          })
        )}
      </ul>

      <div className={styles.divider} />

      <ul className={styles.list}>
        <li>
          <button
            type="button"
            className={`${styles.node} ${isRulesActive ? styles.active : ''}`}
            onClick={onSelectRules}
          >
            <span className={styles.nodeIcon}>🔗</span>
            <span className={styles.nodeLabel}>跨域规则</span>
          </button>
        </li>
      </ul>
    </aside>
  )
}
