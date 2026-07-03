import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { Checkbox } from '../../../components/ui/Checkbox'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { Select } from '../../../components/ui/Select'
import { Textarea } from '../../../components/ui/Textarea'
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
  groupRepoUrl?: string | null
  groupRepoDefaultBranch?: string | null
  groupExtraRepos?: string | null
  groupWorktreeMode?: string | null
  memberAgentNames?: string[]
  onClose: () => void
  onSaveName: (name: string) => void
  onSaveWorkingDir: (dir: string | null) => void
  onSaveGuidancePrompt: (prompt: string | null) => void
  onSaveRepo: (data: { repoUrl: string | null; repoDefaultBranch: string | null; extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode: 'group' | 'issue' | null }) => void
}

interface ExtraRepoEntry { id: string; url: string; branch?: string; mountPath: string }

function parseExtraRepos(json: string | null | undefined): ExtraRepoEntry[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is ExtraRepoEntry =>
      !!e && typeof e === 'object'
      && typeof e.id === 'string'
      && typeof e.url === 'string'
      && typeof e.mountPath === 'string')
  } catch { return [] }
}

export function GroupSettingsModal({
  open,
  groupId,
  groupName,
  groupWorkingDir,
  groupGuidancePrompt,
  groupRepoUrl,
  groupRepoDefaultBranch,
  groupExtraRepos,
  groupWorktreeMode,
  memberAgentNames,
  onClose,
  onSaveName,
  onSaveWorkingDir,
  onSaveGuidancePrompt,
  onSaveRepo,
}: GroupSettingsModalProps) {
  const [nameValue, setNameValue] = useState(groupName)
  const [dirValue, setDirValue] = useState(groupWorkingDir || '')
  const [guidanceValue, setGuidanceValue] = useState(groupGuidancePrompt || '')
  const [repoUrlValue, setRepoUrlValue] = useState(groupRepoUrl || '')
  const [repoBranchValue, setRepoBranchValue] = useState(groupRepoDefaultBranch || '')
  const [extraReposValue, setExtraReposValue] = useState<Array<{ id: string; url: string; branch: string }>>(
    parseExtraRepos(groupExtraRepos).map(e => ({ id: e.id, url: e.url, branch: e.branch || '' })),
  )
  const [worktreeModeValue, setWorktreeModeValue] = useState<'group' | 'issue'>(groupWorktreeMode === 'issue' ? 'issue' : 'group')
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const updateExtra = (idx: number, field: 'id' | 'url' | 'branch', value: string) => {
    setExtraReposValue(prev => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e))
  }
  const addExtra = () => setExtraReposValue(prev => [...prev, { id: '', url: '', branch: '' }])
  const removeExtra = (idx: number) => setExtraReposValue(prev => prev.filter((_, i) => i !== idx))

  useEffect(() => {
    if (open) {
      setNameValue(groupName)
      setDirValue(groupWorkingDir || '')
      setGuidanceValue(groupGuidancePrompt || '')
      setRepoUrlValue(groupRepoUrl || '')
      setRepoBranchValue(groupRepoDefaultBranch || '')
      setExtraReposValue(parseExtraRepos(groupExtraRepos).map(e => ({ id: e.id, url: e.url, branch: e.branch || '' })))
      setWorktreeModeValue(groupWorktreeMode === 'issue' ? 'issue' : 'group')
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    }
  }, [open, groupName, groupWorkingDir, groupGuidancePrompt, groupRepoUrl, groupRepoDefaultBranch, groupExtraRepos, groupWorktreeMode])

  const nameTrimmed = nameValue.trim()
  const nameDirty = nameTrimmed !== groupName.trim()
  const dirTrimmed = dirValue.trim()
  const dirDirty = dirTrimmed !== (groupWorkingDir || '').trim()
  const guidanceTrimmed = guidanceValue.trim()
  const guidanceDirty = guidanceTrimmed !== (groupGuidancePrompt || '').trim()
  const repoUrlTrimmed = repoUrlValue.trim()
  const repoBranchTrimmed = repoBranchValue.trim()
  const origRepoUrl = (groupRepoUrl || '').trim()
  const origRepoBranch = (groupRepoDefaultBranch || '').trim()
  const origExtras = parseExtraRepos(groupExtraRepos)
  const origWorktreeMode = groupWorktreeMode === 'issue' ? 'issue' : 'group'
  // 比较 extras:JSON 字符串化后对比(忽略 mountPath 差异,因为 mountPath 自动 = repos/<id>)
  const extrasJson = JSON.stringify(extraReposValue.map(e => ({ id: e.id.trim(), url: e.url.trim(), branch: e.branch.trim() })))
  const origExtrasJson = JSON.stringify(origExtras.map(e => ({ id: e.id, url: e.url, branch: e.branch || '' })))
  const repoDirty = repoUrlTrimmed !== origRepoUrl
    || repoBranchTrimmed !== origRepoBranch
    || extrasJson !== origExtrasJson
    || worktreeModeValue !== origWorktreeMode
  const canSave = nameDirty || dirDirty || guidanceDirty || repoDirty

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
    if (repoDirty) {
      const filled = extraReposValue.filter(e => e.id.trim() && e.url.trim())
      const extras = filled.map(e => ({
        id: e.id.trim(),
        url: e.url.trim(),
        branch: e.branch.trim() || undefined,
        mountPath: `__repos/${e.id.trim()}`,
      }))
      onSaveRepo({
        repoUrl: repoUrlTrimmed || null,
        repoDefaultBranch: repoBranchTrimmed || null,
        extraRepos: extras.length > 0 ? extras : null,
        worktreeMode: worktreeModeValue,
      })
    }
    if (nameDirty || dirDirty || guidanceDirty || repoDirty) {
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
          <Textarea
            value={guidanceValue}
            onChange={e => setGuidanceValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="全群一份,群内所有 agent 被唤起时拼到 prompt 上。例:本群讨论 VR 需求,所有回复聚焦用户场景;提问其他 agent 必须用 scripts/rotom-ask-with-timeout.mjs。"
            rows={4}
            spellCheck={false}
            autoComplete="off"
          />
          <p className={styles.hint}>
            <span className={styles.hintIcon}>💡</span>
            <span>群级别硬约定,所有成员都会看到。留空保存等同于清除。不支持 per-member 覆盖。</span>
          </p>
        </div>

        {/* Repo Config (migration 051) */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="group-settings-repo-url">内置 repo(可选)</label>
          <input
            id="group-settings-repo-url"
            type="text"
            value={repoUrlValue}
            onChange={e => setRepoUrlValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="如 git@github.com:org/repo.git 或 https://github.com/org/repo.git,留空则关闭 worktree 模式"
            className={styles.dirInput}
            spellCheck={false}
            autoComplete="off"
          />
          <input
            type="text"
            value={repoBranchValue}
            onChange={e => setRepoBranchValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="默认分支(如 main/master);留空用仓库默认"
            className={styles.dirInput}
            style={{ marginTop: 6 }}
            spellCheck={false}
            autoComplete="off"
          />
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--color-slate, #888)', whiteSpace: 'nowrap' }}>worktree 模式</label>
            <Select
              value={worktreeModeValue}
              onChange={e => setWorktreeModeValue(e.target.value as 'group' | 'issue')}
              className={styles.dirInput}
              style={{ flex: 1 }}
              options={[
                { value: 'group', label: 'group(群共享一个 worktree,轻量,适合单分支线性开发)' },
                { value: 'issue', label: 'issue(每 issue 独立 worktree,多分支并行)' },
              ]}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--color-slate, #888)' }}>额外仓库(可选)</span>
              <button type="button" onClick={addExtra}
                style={{ border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', color: 'var(--color-navy)', borderRadius: 4, padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}>
                + 添加
              </button>
            </div>
            {extraReposValue.map((e, idx) => (
              <div key={idx} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 110px 28px', gap: 6, marginBottom: 6 }}>
                <Input type="text" size="sm" value={e.id} onChange={ev => updateExtra(idx, 'id', ev.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="id(如 deposit-home)" style={{ fontSize: 11 }} spellCheck={false} autoComplete="off" />
                <Input type="text" size="sm" value={e.url} onChange={ev => updateExtra(idx, 'url', ev.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="URL" style={{ fontSize: 11 }} spellCheck={false} autoComplete="off" />
                <Input type="text" size="sm" value={e.branch} onChange={ev => updateExtra(idx, 'branch', ev.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="分支(可空)" style={{ fontSize: 11 }} spellCheck={false} autoComplete="off" />
                <button type="button" onClick={() => removeExtra(idx)}
                  style={{ border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#c00' }}
                  title="删除">
                  ✕
                </button>
              </div>
            ))}
            <p style={{ fontSize: 11, color: 'var(--color-slate, #888)', margin: '4px 2px 0' }}>
              mountPath 自动 = <code>repos/&lt;id&gt;</code>;agent 在 primary worktree 里通过该路径访问额外仓库。
            </p>
          </div>
          <p className={styles.hint}>
            <span className={styles.hintIcon}>💡</span>
            <span>配 repo 后,该群每个 issue 在 executor 本机起独立 worktree(<code>&lt;groupId&gt;/&lt;issueId&gt;/repos/primary/</code>),多分支天然隔离。同 URL 跨 group/issue 全局复用 bare clone。仅与 master 同机器的 agent 生效。</span>
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
  const { myAgentName, agents } = useChatContext()
  const [allSkills, setAllSkills] = useState<SkillIndex[]>([])
  const [bindings, setBindings] = useState<SkillBinding[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string>('')  // "agentName:skillName" 防抖

  // 真人不参与 skill 绑定(category === "真人"),优先取群成员 profile override,回落全局 agent profile。
  const aiAgentNames = useMemo(() => {
    const byName = new Map(agents.map(a => [a.name, a]))
    return memberAgentNames.filter(aname => {
      const member = byName.get(aname)
      return member?.profile?.category !== '真人'
    })
  }, [memberAgentNames, agents])


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

  if (aiAgentNames.length === 0) return null

  return (
    <div className={styles.summary} style={{ marginTop: 12 }}>
      <div style={{ marginBottom: 10 }}>
        <div className={styles.summaryLabel}>⚡ 技能绑定(per agent)</div>
        <div style={{ fontSize: 11, color: 'var(--color-slate, #888)', marginTop: 2, lineHeight: 1.4 }}>
          勾选的 skill 会在该 agent 执行时注入 prompt 指针。全局 skill 在工具箱管理。
        </div>
      </div>
      {err && <div style={{ color: '#c00', fontSize: 12, marginBottom: 6 }}>{err}</div>}
      {allSkills.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-slate, #888)', padding: '8px 0' }}>
          暂无 skill。去工具箱「技能」tab 新建,或 `rotom memory promote-to-skill` 沉淀。
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {aiAgentNames.map(aname => (
            <div key={aname} style={{ padding: '6px 0', borderTop: '1px solid var(--border-color-light, #eee)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--color-navy, #1a365d)' }}>{aname}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {allSkills.map(s => {
                  const checked = bindings.some(b => b.agent_name === aname && b.skill_id === s.id)
                  const key = `${aname}:${s.id}`
                  return (
                    <div key={s.id} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 11, padding: '4px 10px',
                      border: `1px solid ${checked ? 'var(--color-wise-green, #2f7a2f)' : 'var(--border-color-light, #ddd)'}`,
                      borderRadius: 6, cursor: busy === key ? 'wait' : 'pointer',
                      userSelect: 'none', lineHeight: 1.2,
                      background: checked ? 'rgba(47, 122, 47, 0.08)' : 'transparent',
                      color: checked ? 'var(--color-wise-green, #2f7a2f)' : 'var(--color-navy, #1a365d)',
                      opacity: busy === key ? 0.5 : 1,
                      transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                    }}>
                      <Checkbox
                        checked={checked}
                        onChange={() => toggle(aname, s)}
                        disabled={busy === key}
                        name={s.name}
                      />
                      <span onClick={() => toggle(aname, s)} style={{ cursor: busy === key ? 'wait' : 'pointer' }}>{s.name}</span>
                    </div>
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
