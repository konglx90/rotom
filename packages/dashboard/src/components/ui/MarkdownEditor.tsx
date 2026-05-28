import { useState } from 'react'
import { MarkdownContent } from './MarkdownContent'
import styles from './MarkdownEditor.module.css'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  rows?: number
  disabled?: boolean
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  label,
  rows = 6,
  disabled = false,
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        {label && <span className={styles.label}>{label}</span>}
        <button
          type="button"
          className={styles.toggleBtn}
          onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
          disabled={disabled}
        >
          {mode === 'edit' ? '预览' : '编辑'}
        </button>
      </div>
      {mode === 'edit' ? (
        <textarea
          className={styles.textarea}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
        />
      ) : (
        <div className={styles.preview}>
          {value.trim() ? (
            <MarkdownContent content={value} />
          ) : (
            <span className={styles.emptyHint}>暂无内容</span>
          )}
        </div>
      )}
    </div>
  )
}
