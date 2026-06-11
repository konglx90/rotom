import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from './WorkingDirModal.module.css'

interface WorkingDirModalProps {
  open: boolean
  scope: 'group' | 'direct' | 'member'
  scopeName: string
  currentDir: string | null | undefined
  /** When scope='member', display this in the empty-state hint. */
  fallbackDir?: string | null
  onClose: () => void
  onSubmit: (dir: string | null) => void
}

export function WorkingDirModal({
  open,
  scope,
  scopeName,
  currentDir,
  fallbackDir,
  onClose,
  onSubmit,
}: WorkingDirModalProps) {
  const [value, setValue] = useState(currentDir || '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(currentDir || '')
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [open, currentDir])

  const scopeLabel = scope === 'group' ? '群' : scope === 'direct' ? '对话' : '成员'
  const trimmed = value.trim()
  const dirty = trimmed !== (currentDir || '').trim()
  const canClear = Boolean(currentDir)

  const emptyHint =
    scope === 'member' && fallbackDir
      ? `当前未设置（将使用群工作目录：${fallbackDir}）`
      : '当前未设置（将使用 Agent 默认目录）'

  const handleSave = () => {
    onSubmit(trimmed ? trimmed : null)
  }

  const handleClear = () => {
    onSubmit(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      title="设置工作目录"
      onClose={onClose}
      footer={
        <div className={styles.actions}>
          <div className={styles.actionsLeft}>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              disabled={!canClear}
              title={canClear ? '清除当前的工作目录设置' : '当前未设置工作目录'}
            >
              清除设置
            </Button>
          </div>
          <div className={styles.actionsRight}>
            <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSave}
              disabled={!dirty}
            >
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.header}>
        <div className={styles.iconBadge}>📁</div>
        <div className={styles.headerText}>
          <h4 className={styles.headerTitle}>{scopeLabel}：{scopeName}</h4>
          <p
            className={`${styles.headerSubtitle} ${currentDir ? '' : styles.headerSubtitleEmpty}`}
            title={currentDir || undefined}
          >
            {currentDir ? `当前：${currentDir}` : emptyHint}
          </p>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="working-dir-input">目录路径</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputPrefix}>📂</span>
          <input
            id="working-dir-input"
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="例如 ~/code/my-repo 或 /Users/me/work"
            className={styles.input}
            spellCheck={false}
            autoComplete="off"
          />
          {value && (
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => {
                setValue('')
                inputRef.current?.focus()
              }}
              title="清空输入"
              aria-label="清空输入"
            >
              ✕
            </button>
          )}
        </div>
        <p className={styles.hint}>
          <span className={styles.hintIcon}>💡</span>
          <span>
            支持 <code>~/</code> 自动展开为用户主目录；必须是已存在的目录。留空保存等同于清除设置。
          </span>
        </p>
      </div>
    </Modal>
  )
}
