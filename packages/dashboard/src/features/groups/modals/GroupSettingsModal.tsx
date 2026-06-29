import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Modal } from '../../../components/ui/Modal'
import { GuidanceTemplatePicker } from './GuidanceTemplatePicker'
import { skillsApi } from '../../../api/skills'
import type { SkillIndex, SkillBinding } from '../../../api/skills'
import { useChatContext } from '../../../context/ChatContext'
import styles from './GroupSettingsModal.module.css'

interface GroupSettingsModalProps {
  open: boolean
  groupId: string
  groupName: string
  groupWorkingDir: string | null | undefined
  groupGuidancePrompt?: string | null
  memberAgentNames?: string[]
  onClose: () => void
  onSaveName: (name: string) => void
  onSaveWorkingDir: (dir: string | null) => void
  onSaveGuidancePrompt: (prompt: string | null) => void
}

export function GroupSettingsModal({
  open,
  groupId,
  groupName,
  groupWorkingDir,
  groupGuidancePrompt,
  memberAgentNames,
  onClose,
  onSaveName,
  onSaveWorkingDir,
  onSaveGuidancePrompt,
}: GroupSettingsModalProps) {
  const [nameValue, setNameValue] = useState(groupName)
  const [dirValue, setDirValue] = useState(groupWorkingDir || '')
  const [guidanceValue, setGuidanceValue] = useState(groupGuidancePrompt || '')
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setNameValue(groupName)
      setDirValue(groupWorkingDir || '')
      setGuidanceValue(groupGuidancePrompt || '')
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    }
  }, [open, groupName, groupWorkingDir, groupGuidancePrompt])

  const nameTrimmed = nameValue.trim()
  const nameDirty = nameTrimmed !== groupName.trim()
  const dirTrimmed = dirValue.trim()
  const dirDirty = dirTrimmed !== (groupWorkingDir || '').trim()
  const guidanceTrimmed = guidanceValue.trim()
  const guidanceDirty = guidanceTrimmed !== (groupGuidancePrompt || '').trim()
  const canSave = nameDirty || dirDirty || guidanceDirty

  const handleSave = () => {
    if (nameDirty && nameTrimmed) {
      onSaveName(nameTrimmed)
    }
    if (dirDirty) {
      onSaveWorkingDir(dirTrimmed ? dirTrimmed : null)
    }
    if (guidanceDirty) {
      onSaveGuidancePrompt(guidanceTrimmed ? guidanceTrimmed : null)
    }
    if (nameDirty || dirDirty || guidanceDirty) {
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

        {/* Guidance Prompt */}
        <div className={styles.field}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label className={styles.label} htmlFor="group-settings-guidance">群指导 prompt</label>
            <button
              type="button"
              onClick={() => setShowTemplatePicker(true)}
              style={{
                border: '1px solid rgba(0,0,0,0.12)',
                background: 'transparent',
                color: 'var(--color-navy)',
                borderRadius: 6,
                padding: '2px 10px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              📚 从模板选择
            </button>
          </div>
          <textarea
            id="group-settings-guidance"
            value={guidanceValue}
            onChange={e => setGuidanceValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="全群一份,群内所有 agent 被唤起时拼到 prompt 上。例:本群讨论 VR 需求,所有回复聚焦用户场景;提问其他 agent 必须用 scripts/rotom-ask-with-timeout.mjs。"
            className={styles.guidanceTextarea}
            rows={4}
            spellCheck={false}
            autoComplete="off"
          />
          <p className={styles.hint}>
            <span className={styles.hintIcon}>💡</span>
            <span>群级别硬约定,所有成员都会看到。留空保存等同于清除。不支持 per-member 覆盖。</span>
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
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>当前指导</span>
            <span className={`${styles.summaryValue} ${!groupGuidancePrompt ? styles.summaryValueEmpty : ''}`}>
              {groupGuidancePrompt ? `${groupGuidancePrompt.slice(0, 60)}${groupGuidancePrompt.length > 60 ? '…' : ''}` : '未设置'}
            </span>
          </div>
        </div>
      </div>

      <SkillBindingsSection groupId={groupId} memberAgentNames={memberAgentNames ?? []} />

      {showTemplatePicker && (
        <GuidanceTemplatePicker
          open={showTemplatePicker}
          groupId={groupId}
          groupName={groupName}
          memberAgentNames={memberAgentNames ?? []}
          onPromptApplied={(resolved) => setGuidanceValue(resolved)}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}
    </Modal>
  )
}

/** 每个 agent 勾选该群要绑定的 skill。勾选实时 bind/unbind。 */
function SkillBindingsSection({ groupId, memberAgentNames }: { groupId: string; memberAgentNames: string[] }) {
  const { myAgentName } = useChatContext()
  const [allSkills, setAllSkills] = useState<SkillIndex[]>([])
  const [bindings, setBindings] = useState<SkillBinding[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string>('')  // "agentName:skillName" 防抖

  const reload = () => {
    Promise.all([skillsApi.list(), skillsApi.listBindings(groupId)])
      .then(([s, b]) => { setAllSkills(s); setBindings(b) })
      .catch(e => setErr((e as Error).message))
  }
  useEffect(() => { reload() }, [groupId])

  const toggle = async (agentName: string, skill: SkillIndex) => {
    const key = `${agentName}:${skill.id}`
    if (busy) return
    setBusy(key)
    try {
      const isBound = bindings.some(b => b.agent_name === agentName && b.skill_id === skill.id)
      if (isBound) {
        await skillsApi.unbind(groupId, agentName, skill.name)
      } else {
        await skillsApi.bind(groupId, agentName, skill.name, myAgentName)
      }
      await reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  if (memberAgentNames.length === 0) return null

  return (
    <div className={styles.summary} style={{ marginTop: 12 }}>
      <div className={styles.summaryRow} style={{ marginBottom: 8 }}>
        <span className={styles.summaryLabel}>技能绑定(per agent)</span>
        <span className={styles.summaryValue} style={{ fontSize: 11, color: 'var(--color-slate, #888)' }}>
          勾选的 skill 会在该 agent 执行时注入 prompt 指针。全局 skill 在工具箱管理。
        </span>
      </div>
      {err && <div style={{ color: '#c00', fontSize: 12, marginBottom: 6 }}>{err}</div>}
      {allSkills.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-slate, #888)', padding: '8px 0' }}>
          暂无 skill。去工具箱「技能」tab 新建,或 `rotom memory promote-to-skill` 沉淀。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {memberAgentNames.map(aname => (
            <div key={aname} style={{ padding: '6px 0', borderTop: '1px solid var(--border-color-light, #eee)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{aname}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {allSkills.map(s => {
                  const checked = bindings.some(b => b.agent_name === aname && b.skill_id === s.id)
                  const key = `${aname}:${s.id}`
                  return (
                    <label key={s.id} style={{
                      fontSize: 11, padding: '2px 8px',
                      border: `1px solid ${checked ? 'var(--color-wise-green, #2f7a2f)' : 'var(--border-color-light, #ddd)'}`,
                      borderRadius: 4, cursor: 'pointer',
                      background: checked ? 'rgba(47, 122, 47, 0.08)' : 'transparent',
                      opacity: busy === key ? 0.5 : 1,
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy === key}
                        onChange={() => toggle(aname, s)}
                        style={{ marginRight: 4 }}
                      />
                      {s.name}
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
