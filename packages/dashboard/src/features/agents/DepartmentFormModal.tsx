import { useEffect, useState } from 'react'
import { domainsApi } from '../../api/domains'
import type { Domain } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { Modal } from '../../components/ui/Modal'
import styles from './DepartmentFormModal.module.css'

type Mode = 'create' | 'edit'

interface DepartmentFormModalProps {
  open: boolean
  mode: Mode
  domain?: Domain | null
  onClose: () => void
  onSuccess: () => void
}

export function DepartmentFormModal({
  open,
  mode,
  domain,
  onClose,
  onSuccess,
}: DepartmentFormModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSubmitting(false)
    if (mode === 'edit' && domain) {
      setName(domain.name)
      setDescription(domain.description ?? '')
    } else {
      setName('')
      setDescription('')
    }
  }, [open, mode, domain])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入部门名称')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'create') {
        await domainsApi.create({
          name: trimmed,
          description: description.trim() || undefined,
        })
      } else if (domain) {
        await domainsApi.update(domain.id, {
          name: trimmed,
          description: description.trim() || undefined,
        })
      }
      onSuccess()
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const title = mode === 'create' ? '添加部门' : '重命名部门'
  const submitLabel = mode === 'create' ? '创建' : '保存'

  return (
    <Modal open={open} title={title} onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <Input
            label="部门名称"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：技术部"
            autoFocus
            disabled={submitting}
          />
        </div>

        <div className={styles.field}>
          <Input
            label="描述（可选）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简要描述该部门的职责"
            disabled={submitting}
          />
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </Button>
          <Button type="submit" variant="primary" size="md" disabled={submitting}>
            {submitting ? '提交中…' : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
