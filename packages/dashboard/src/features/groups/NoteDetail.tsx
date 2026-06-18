import { useEffect, useState } from 'react'
import type { Note } from '../../api/types'
import { notesApi } from '../../api/notes'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { MarkdownEditor } from '../../components/ui/MarkdownEditor'
import styles from './NotePanel.module.css'

interface NoteDetailProps {
  noteId: string
  /** 父组件递增的版本号,变化时强制重新拉取 */
  refreshSignal: number
  onBack: () => void
  onChanged: () => void
}

export function NoteDetail({ noteId, refreshSignal, onBack, onChanged }: NoteDetailProps) {
  const [note, setNote] = useState<Note | null>(null)
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    notesApi.getById(noteId)
      .then(data => {
        if (cancelled) return
        setNote(data)
        setTitleDraft(data.title)
        setDescDraft(data.description)
        setEditing(false)
      })
      .catch(err => {
        if (!cancelled) setError(err?.message ?? '加载失败')
      })
    return () => { cancelled = true }
  }, [noteId, refreshSignal])

  const startEdit = () => {
    if (!note) return
    setTitleDraft(note.title)
    setDescDraft(note.description)
    setEditing(true)
  }

  const cancelEdit = () => {
    if (!note) return
    setTitleDraft(note.title)
    setDescDraft(note.description)
    setEditing(false)
  }

  const saveEdit = async () => {
    if (!note) return
    const newTitle = titleDraft.trim()
    if (!newTitle) {
      setError('标题不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await notesApi.update(note.id, { title: newTitle, description: descDraft })
      const fresh = await notesApi.getById(note.id)
      setNote(fresh)
      setTitleDraft(fresh.title)
      setDescDraft(fresh.description)
      setEditing(false)
      onChanged()
    } catch (err: any) {
      setError(err?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!note) return
    if (!window.confirm(`确认删除 note "${note.title}"?此操作不可恢复。`)) return
    try {
      await notesApi.delete(note.id)
      onChanged()
      onBack()
    } catch (err: any) {
      setError(err?.message ?? '删除失败')
    }
  }

  if (error && !note) {
    return (
      <div className={styles.noteDetail}>
        <div className={styles.noteDetailHeader}>
          <button className={styles.noteDetailBack} onClick={onBack}>← 返回</button>
        </div>
        <div className={styles.noteEmpty}>{error}</div>
      </div>
    )
  }

  if (!note) {
    return (
      <div className={styles.noteDetail}>
        <div className={styles.noteDetailHeader}>
          <button className={styles.noteDetailBack} onClick={onBack}>← 返回</button>
        </div>
        <div className={styles.noteEmpty}>加载中...</div>
      </div>
    )
  }

  return (
    <div className={styles.noteDetail}>
      <div className={styles.noteDetailHeader}>
        <button className={styles.noteDetailBack} onClick={onBack}>← 返回</button>
        {editing ? (
          <input
            type="text"
            className={styles.noteDetailTitleInput}
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            autoFocus
          />
        ) : (
          <span
            className={styles.noteDetailTitleText}
            onClick={startEdit}
            title="点击编辑标题"
          >
            {note.title}
          </span>
        )}
        <div className={styles.noteDetailActions}>
          {editing ? (
            <>
              <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>取消</Button>
              <Button variant="primary" size="sm" onClick={saveEdit} disabled={saving}>保存</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={startEdit}>编辑</Button>
              <Button variant="ghost" size="sm" onClick={handleDelete}>删除</Button>
            </>
          )}
        </div>
      </div>
      <div className={styles.noteDetailMeta}>
        创建者:{note.created_by} · 更新于:{note.updated_at}
      </div>
      {error && <div style={{ padding: '6px 14px', color: '#c00', fontSize: 12 }}>{error}</div>}
      {editing ? (
        <div className={styles.noteDetailEditor}>
          <MarkdownEditor
            value={descDraft}
            onChange={setDescDraft}
            label="内容 (Markdown)"
            rows={16}
          />
          <div className={styles.noteDetailEditorActions}>
            <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>取消</Button>
            <Button variant="primary" size="sm" onClick={saveEdit} disabled={saving}>保存</Button>
          </div>
        </div>
      ) : (
        <div className={styles.noteDetailBody}>
          {note.description.trim() ? (
            <MarkdownContent content={note.description} />
          ) : (
            <span style={{ color: 'var(--color-gray)', fontSize: 13 }}>（暂无内容,点击右上角编辑）</span>
          )}
        </div>
      )}
    </div>
  )
}
