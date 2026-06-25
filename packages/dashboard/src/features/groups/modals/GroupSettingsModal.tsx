import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import styles from './GroupSettingsModal.module.css'

interface GroupSettingsModalProps {
  open: boolean
  groupName: string
  groupWorkingDir: string | null | undefined
  onClose: () => void
  onSaveName: (name: string) => void
  onSaveWorkingDir: (dir: string | null) => void
}

export function GroupSettingsModal({
  open,
  groupName,
  groupWorkingDir,
  onClose,
  onSaveName,
  onSaveWorkingDir,
}: GroupSettingsModalProps) {
  const [nameValue, setNameValue] = useState(groupName)
  const [dirValue, setDirValue] = useState(groupWorkingDir || '')
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setNameValue(groupName)
      setDirValue(groupWorkingDir || '')
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    }
  }, [open, groupName, groupWorkingDir])

  const nameTrimmed = nameValue.trim()
  const nameDirty = nameTrimmed !== groupName.trim()
  const dirTrimmed = dirValue.trim()
  const dirDirty = dirTrimmed !== (groupWorkingDir || '').trim()
  const canSave = nameDirty || dirDirty

  const handleSave = () => {
    if (nameDirty && nameTrimmed) {
      onSaveName(nameTrimmed)
    }
    if (dirDirty) {
      onSaveWorkingDir(dirTrimmed ? dirTrimmed : null)
    }
    if (nameDirty || dirDirty) {
      onClose()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
      title="群设置"
      onClose={onClose}
      footer={
        <div className={styles.footerActions}>
          <div />
          <div className={styles.footerRight}>
            <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
            <Button variant="primary" size="md" onClick={handleSave} disabled={!canSave}>
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.body}>
        {/* Group Name */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="group-settings-name">群名称</label>
          <div className={styles.nameInputWrap}>
            <span className={styles.inputPrefix}>💬</span>
            <input
              id="group-settings-name"
              ref={nameInputRef}
              type="text"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入群名称"
              className={styles.nameInput}
              spellCheck={false}
              autoComplete="off"
            />
            {nameValue && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => { setNameValue(''); nameInputRef.current?.focus() }}
                title="清空"
                aria-label="清空"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Working Directory */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="group-settings-dir">工作目录</label>
          <div className={styles.dirInputWrap}>
            <span className={styles.inputPrefix}>📂</span>
            <input
              id="group-settings-dir"
              type="text"
              value={dirValue}
              onChange={e => setDirValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="例如 ~/code/my-repo 或 /Users/me/work"
              className={styles.dirInput}
              spellCheck={false}
              autoComplete="off"
            />
            {dirValue && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => { setDirValue(''); nameInputRef.current?.focus() }}
                title="清空"
                aria-label="清空"
              >
                ✕
              </button>
            )}
          </div>
          <p className={styles.hint}>
            <span className={styles.hintIcon}>💡</span>
            <span>支持 <code>~/</code> 展开；必须是已存在的目录。留空保存等同于清除设置。</span>
          </p>
        </div>

        {/* Current values summary */}
        <div className={styles.summary}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>当前名称</span>
            <span className={styles.summaryValue}>{groupName}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>当前目录</span>
            <span className={`${styles.summaryValue} ${!groupWorkingDir ? styles.summaryValueEmpty : ''}`}>
              {groupWorkingDir || '未设置'}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  )
}
