// ArtifactPanel 分支对比相关的展示原语:repo 名解析、文件状态徽标映射、
// 以及可输入下拉的 ref 选择器。从 ArtifactPanel.tsx 抽出。
import { useMemo } from 'react'
import type { ArtifactRefs } from '../../../api/artifacts'
import { Input } from '../../../components/ui/Input'
import styles from './ArtifactPanel.module.css'

/** 从 repo url 提取展示名(`https://gitlab.xxx/GroupName/kael-trade-h5.git` →
 *  `kael-trade-h4`)。和后端 repoNameFor 算法一致,前端不引后端代码,这里
 *  几行复刻一下。 */
export function repoDisplayName(url: string): string {
  let u = url.trim()
  if (u.endsWith('.git')) u = u.slice(0, -4)
  u = u.split('?')[0].split('#')[0].replace(/\/$/, '')
  const last = u.split('/').pop() || 'repo'
  return last || 'repo'
}

/** 分支对比文件列表的状态徽标。颜色用内联 style,避免为 5 个状态单独加 CSS。 */
export const STATUS_LABEL: Record<string, string> = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  C: '复制',
  U: '未合并',
  T: '类型变',
}
export const STATUS_COLOR: Record<string, string> = {
  A: '#2f7a2f',
  M: '#b8860b',
  D: '#c0392b',
  R: '#6c757d',
  C: '#6c757d',
  U: '#c0392b',
  T: '#6c757d',
}

/** 单个 input + datalist 实现的可输入下拉(HTML5 原生 combobox)。既能
 *  从下拉里选常用 ref(分支/tag/HEAD),也能直接手输 commit/tag。比 Select+Input
 *  双控件省一半空间,且只显示一次当前值,不会出现"Select 显示一次 + Input
 *  又显示一次"的重复。datalist 原生不支持 optgroup,这里把 tag 加 `tags/`
 *  前缀扁平化列出,和后端 ref 接受的格式一致。 */
export function RefSelector({
  value,
  onChange,
  onEnter,
  refs,
  placeholder,
  title,
}: {
  value: string
  onChange: (v: string) => void
  onEnter?: () => void
  refs: ArtifactRefs | null
  placeholder?: string
  title?: string
}) {
  // datalist id 必须全局唯一,多个 RefSelector 共存时不能撞。
  const listId = useMemo(() => `rotom-ref-list-${Math.random().toString(36).slice(2, 10)}`, [])
  return (
    <>
      <Input
        className={styles.diffBaseInput}
        size="sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.() }}
        placeholder={placeholder || 'commit / 分支 / tag'}
        title={title || 'git ref / commit / 分支,回车发起对比;可从下拉选常用 ref'}
        list={listId}
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={listId}>
        {/* 空值代表 HEAD;datalist 的 option 没有"value + label"分离,空 value
            会在下拉里显示为空白条,这里改用 "HEAD" 字面量作为可选项。 */}
        <option value="HEAD">HEAD(默认)</option>
        {refs?.heads.map((r) => (
          <option key={r} value={r} label={r === refs.head ? `${r} (当前)` : r} />
        ))}
        {refs?.tags.map((t) => (
          <option key={`tags/${t}`} value={`tags/${t}`} label={`tag · ${t}`} />
        ))}
      </datalist>
    </>
  )
}
