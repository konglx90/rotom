import { useEffect, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Issue } from '../../../api/types'
import { truncateTitle } from '../createIssueTitle'

export interface IssueEditState {
  editing: boolean
  editDescription: string
  setEditDescription: (v: string) => void
  /** 实时预览:title 从 editDescription 截断生成,只读。 */
  editTitlePreview: string
  savingEdit: boolean
  editError: string | null
  startEdit: () => void
  cancelEdit: () => void
  saveEdit: () => Promise<void>
}

// useIssueEdit — owns the description draft state and the save pipeline.
// title 不再可编辑,由后端从 description 截断生成;这里仅提供预览。
// /plan 模式由 description 内容首 token 决定,无需独立 checkbox。
export function useIssueEdit(issue: Issue | null, reload: () => Promise<void> | void): IssueEditState {
  const [editing, setEditing] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setEditError(null)
  }, [issue?.id])

  const startEdit = () => {
    if (!issue) return
    setEditDescription(issue.description || '')
    setEditError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditError(null)
  }

  const saveEdit = async () => {
    if (!issue) return
    const desc = editDescription.trim()
    if (!desc) {
      setEditError('内容不能为空')
      return
    }
    const descChanged = editDescription !== (issue.description || '')
    if (!descChanged) {
      setEditing(false)
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      // 只发 description,后端会重新截断 title 并重解析 slash_command。
      await issuesApi.update(issue.id, { description: editDescription })
      setEditing(false)
      await reload()
    } catch (err) {
      setEditError((err as Error).message || '保存失败')
    } finally {
      setSavingEdit(false)
    }
  }

  return {
    editing,
    editDescription,
    setEditDescription,
    editTitlePreview: truncateTitle(editDescription),
    savingEdit,
    editError,
    startEdit,
    cancelEdit,
    saveEdit,
  }
}
