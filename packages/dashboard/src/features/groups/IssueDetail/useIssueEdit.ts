import { useEffect, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Issue } from '../../../api/types'

export interface IssueEditState {
  editing: boolean
  editTitle: string
  setEditTitle: (v: string) => void
  editDescription: string
  setEditDescription: (v: string) => void
  editPlanMode: boolean
  setEditPlanMode: (v: boolean) => void
  savingEdit: boolean
  editError: string | null
  startEdit: () => void
  cancelEdit: () => void
  saveEdit: () => Promise<void>
}

// useIssueEdit — owns the title/description draft state and the save pipeline.
// The /plan checkbox stays in two-way sync with the title prefix; the save
// short-circuits when nothing actually changed.
export function useIssueEdit(issue: Issue | null, reload: () => Promise<void> | void): IssueEditState {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editPlanMode, setEditPlanMode] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // Reset when the underlying issue switches.
  useEffect(() => {
    setEditing(false)
    setEditError(null)
  }, [issue?.id])

  const startEdit = () => {
    if (!issue) return
    setEditTitle(issue.title)
    setEditDescription(issue.description || '')
    setEditPlanMode(issue.slash_command === '/plan' || issue.title.startsWith('/plan'))
    setEditError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditError(null)
  }

  const saveEdit = async () => {
    if (!issue) return
    let nextTitle = editTitle.trim()
    if (!nextTitle) {
      setEditError('标题不能为空')
      return
    }
    // /plan 复选框与 title 前缀双向同步：勾选则补上前缀，未勾选则剥掉。
    const hasPlanPrefix = nextTitle.startsWith('/plan ') || nextTitle === '/plan'
    if (editPlanMode && !hasPlanPrefix) {
      nextTitle = `/plan ${nextTitle}`
    } else if (!editPlanMode && hasPlanPrefix) {
      nextTitle = nextTitle.replace(/^\/plan\s*/, '').trim()
      if (!nextTitle) {
        setEditError('取消计划模式后标题不能为空')
        return
      }
    }
    const titleChanged = nextTitle !== issue.title
    const descChanged = editDescription !== (issue.description || '')
    if (!titleChanged && !descChanged) {
      setEditing(false)
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      const payload: { title?: string; description?: string } = {}
      if (titleChanged) payload.title = nextTitle
      if (descChanged) payload.description = editDescription
      await issuesApi.update(issue.id, payload)
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
    editTitle,
    setEditTitle,
    editDescription,
    setEditDescription,
    editPlanMode,
    setEditPlanMode,
    savingEdit,
    editError,
    startEdit,
    cancelEdit,
    saveEdit,
  }
}
