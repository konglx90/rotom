import { useEffect, useState } from 'react'
import type { Note } from '../../api/types'
import { notesApi } from '../../api/notes'
import { AsyncBoundary } from '../../components/async/AsyncBoundary'
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
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<Error | null>(null)

  const refetch = () => {
    setLoading(true)
    setLoadError(null)
    notesApi.getById(noteId)
      .then(data => {
        setNote(data)
        setLoading(false)
      })
      .catch(err => {
        setLoadError(err instanceof Error ? err : new Error(err?.message ?? '加载失败'))
        setLoading(false)
      })
  }

  useEffect(() => {
    refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, refreshSignal])

  return (
    <AsyncBoundary
      data={note}
      loading={loading}
      error={loadError}
      onRetry={refetch}
      loadingFallback={
        <div className={styles.noteDetail}>
          <div className={styles.noteDetailHeader}>
            <button className={styles.noteDetailBack} onClick={onBack}>← 返回</button>
          </div>
          <div className={styles.noteEmpty}>加载中...</div>
        </div>
      }
      errorFallback={(err, retry) => (
        <div className={styles.noteDetail}>
          <div className={styles.noteDetailHeader}>
            <button className={styles.noteDetailBack} onClick={onBack}>← 返回</button>
          </div>
          <div className={styles.noteEmpty}>
            {typeof err === 'string' ? err : err.message}
            <Button variant="ghost" size="sm" onClick={retry}>重试</Button>
          </div>
        </div>
      )}
    >
      {(data) => (
        <NoteDetailBody
          note={data}
          onBack={onBack}
          onChanged={onChanged}
        />
      )}
    </AsyncBoundary>
  )
}

interface NoteDetailBodyProps {
  note: Note
  onBack: () => void
  onChanged: () => void
}

function NoteDetailBody({ note, onBack, onChanged }: NoteDetailBodyProps) {
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(note.title)
  const [descDraft, setDescDraft] = useState(note.description)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEdit = () => {
    setTitleDraft(note.title)
    setDescDraft(note.description)
    setEditing(true)
  }

  const cancelEdit = () => {
    setTitleDraft(note.title)
    setDescDraft(note.description)
    setEditing(false)
  }

  const saveEdit = async () => {
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
    if (!window.confirm(`确认删除 note "${note.title}"?此操作不可恢复。`)) return
    try {
      await notesApi.delete(note.id)
      onChanged()
      onBack()
    } catch (err: any) {
      setError(err?.message ?? '删除失败')
    }
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
