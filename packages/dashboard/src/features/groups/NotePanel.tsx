import { useEffect, useState } from 'react'
import type { Note } from '../../api/types'
import { notesApi } from '../../api/notes'
import { Button } from '../../components/ui/Button'
import { CreateNoteDialog } from './CreateNoteDialog'
import { NoteDetail } from './NoteDetail'
import styles from './NotePanel.module.css'

interface NotePanelProps {
  selectedGroupId: string
  myAgentName: string
}

export function NotePanel({ selectedGroupId, myAgentName }: NotePanelProps) {
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedNoteId('')
    setNotes([])
    setError(null)
    notesApi.listByGroup(selectedGroupId)
      .then(setNotes)
      .catch(err => setError(err?.message ?? '加载失败'))
  }, [selectedGroupId, refreshSignal])

  const reload = () => setRefreshSignal(s => s + 1)

  const handleCreate = async (data: { title: string; description?: string }) => {
    await notesApi.create(selectedGroupId, {
      title: data.title,
      description: data.description,
      createdBy: myAgentName,
    })
    reload()
  }

  return (
    <>
      <div className={styles.notePanel}>
        <div className={styles.notePanelHeader}>
          <h3 className={styles.notePanelTitle}>Notes</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowCreateDialog(true)}>+ 创建</Button>
        </div>
        {error ? (
          <div className={styles.noteEmpty}>{error}</div>
        ) : selectedNoteId ? (
          <NoteDetail
            noteId={selectedNoteId}
            refreshSignal={refreshSignal}
            onBack={() => setSelectedNoteId('')}
            onChanged={reload}
          />
        ) : notes.length === 0 ? (
          <div className={styles.noteEmpty}>
            暂无 Note<br />点击上方按钮创建纯文字记录
          </div>
        ) : (
          <ul className={styles.noteList}>
            {notes.map(note => (
              <li
                key={note.id}
                className={`${styles.noteItem} ${selectedNoteId === note.id ? styles.active : ''}`}
                onClick={() => setSelectedNoteId(note.id)}
              >
                <span className={styles.noteTitle}>{note.title}</span>
                <div className={styles.noteMeta}>
                  <span>{note.updated_at}</span>
                  <span className={styles.noteCreatedBy}>{note.created_by}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateNoteDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreate={handleCreate}
      />
    </>
  )
}
