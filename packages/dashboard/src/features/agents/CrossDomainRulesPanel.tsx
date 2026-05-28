import { useEffect, useState } from 'react'
import { rulesApi } from '../../api/domains'
import type { CrossDomainRule, Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import styles from './CrossDomainRulesPanel.module.css'

interface CrossDomainRulesPanelProps {
  domains: Domain[]
}

export function CrossDomainRulesPanel({ domains }: CrossDomainRulesPanelProps) {
  const [rules, setRules] = useState<CrossDomainRule[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddRule, setShowAddRule] = useState(false)
  const [ruleFrom, setRuleFrom] = useState('')
  const [ruleTo, setRuleTo] = useState('')
  const [ruleBidi, setRuleBidi] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const loadRules = async () => {
    setLoading(true)
    try {
      const data = await rulesApi.list()
      setRules(data.rules || [])
    } catch (error) {
      console.error('Failed to load rules:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRules()
  }, [])

  const handleCancel = () => {
    setRuleFrom('')
    setRuleTo('')
    setRuleBidi(true)
    setShowAddRule(false)
  }

  const createRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ruleFrom || !ruleTo) {
      alert('请选择源域和目标域')
      return
    }
    if (ruleFrom === ruleTo) {
      alert('源域和目标域不能相同')
      return
    }

    setSubmitting(true)
    try {
      await rulesApi.create({ from: ruleFrom, to: ruleTo, bidirectional: ruleBidi })
      await loadRules()
      handleCancel()
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建规则失败'
      alert(message)
    } finally {
      setSubmitting(false)
    }
  }

  const deleteRule = async (from: string, to: string) => {
    if (!confirm(`确定删除规则 ${from} → ${to} 吗？`)) return
    try {
      await rulesApi.delete(from, to)
      await loadRules()
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除规则失败'
      alert(message)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>跨域规则</h2>
          <p className={styles.subtitle}>配置不同部门间的数字员工通信权限</p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={() => setShowAddRule(true)}
          disabled={domains.length < 2}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 3a1 1 0 011 1v3h3a1 1 0 110 2H9v3a1 1 0 11-2 0V9H4a1 1 0 110-2h3V4a1 1 0 011-1z" />
          </svg>
          添加规则
        </Button>
      </div>

      {loading ? (
        <div className={styles.loading}>加载中...</div>
      ) : domains.length < 2 ? (
        <div className={styles.warning}>
          当前不足 2 个部门，请先创建多个部门再添加跨域规则
        </div>
      ) : rules.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📋</div>
          <p>暂无跨域规则</p>
          <p className={styles.hint}>添加规则以允许不同部门间的数字员工通信</p>
        </div>
      ) : (
        <div className={styles.rulesTable}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>源部门</th>
                <th></th>
                <th>目标部门</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule, index) => (
                <tr key={index}>
                  <td>
                    <span className={styles.domainTag}>{rule.from_domain}</span>
                  </td>
                  <td className={styles.arrow}>→</td>
                  <td>
                    <span className={`${styles.domainTag} ${styles.domainTagTo}`}>
                      {rule.to_domain}
                    </span>
                  </td>
                  <td>
                    <Button
                      type="button"
                      variant="danger"
                      outline
                      size="sm"
                      onClick={() => deleteRule(rule.from_domain, rule.to_domain)}
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAddRule && (
        <div className={styles.modalOverlay} onClick={handleCancel}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>添加跨域规则</h3>
              <Button variant="ghost" size="sm" iconOnly onClick={handleCancel} title="关闭">&times;</Button>
            </div>

            <form onSubmit={createRule} className={styles.modalForm}>
              <div className={styles.fieldGroup}>
                <div className={styles.field}>
                  <label>源部门</label>
                  <select
                    value={ruleFrom}
                    onChange={(e) => setRuleFrom(e.target.value)}
                    required
                  >
                    <option value="">选择部门</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>

                <div className={styles.arrow}>→</div>

                <div className={styles.field}>
                  <label>目标部门</label>
                  <select
                    value={ruleTo}
                    onChange={(e) => setRuleTo(e.target.value)}
                    required
                  >
                    <option value="">选择部门</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={ruleBidi}
                    onChange={(e) => setRuleBidi(e.target.checked)}
                  />
                  双向（同时创建反向规则）
                </label>
              </div>

              <div className={styles.modalActions}>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={handleCancel}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={submitting || !ruleFrom || !ruleTo || ruleFrom === ruleTo}
                >
                  {submitting ? '提交中…' : '添加'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
