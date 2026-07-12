// ArtifactPanel 的文件树渲染:FileTreeNode 递归组件 + 按路径查找节点。
// 从 ArtifactPanel.tsx 抽出。FileTreeNode 只有本地 expanded 状态。
import { useState } from 'react'
import type { ArtifactFile } from '../../../api/types'
import styles from './ArtifactPanel.module.css'
import { formatSize } from './artifactFileUtils'

/** Depth at which directories are expanded by default on first load. */
const DEFAULT_EXPAND_DEPTH = 1

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['tsx', 'ts', 'jsx', 'js'].includes(ext)) return '\u{1F4C4}'
  if (['css', 'scss', 'less'].includes(ext) || name.endsWith('.module.css')) return '\u{1F3A8}'
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return '\u{1F4E6}'
  if (['md', 'txt', 'doc'].includes(ext)) return '\u{1F4DD}'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) return '\u{1F5BC}'
  return '\u{1F4C4}'
}

/** 在文件树里按 path 递归查找 ArtifactFile 节点(目录节点也匹配,但调用方
 *  一般只关心文件)。返回 null 表示没找到(可能文件已被删除/未生成)。 */
export function findFileByPath(files: ArtifactFile[], path: string): ArtifactFile | null {
  for (const f of files) {
    if (f.path === path) return f
    if (f.type === 'directory' && f.children) {
      const hit = findFileByPath(f.children, path)
      if (hit) return hit
    }
  }
  return null
}

export function FileTreeNode({
  file,
  selectedPath,
  onSelect,
  depth,
  forceExpand = false,
}: {
  file: ArtifactFile
  selectedPath: string | null
  onSelect: (file: ArtifactFile) => void
  depth: number
  /** 搜索模式下强制展开所有目录节点,无视 local expanded state。 */
  forceExpand?: boolean
}) {
  const isDir = file.type === 'directory'
  const [expanded, setExpanded] = useState(() => isDir && depth < DEFAULT_EXPAND_DEPTH)
  const isActive = file.path === selectedPath
  // forceExpand 优先于 local state,让搜索时所有命中路径自动展开
  const effectivelyExpanded = forceExpand || expanded

  return (
    <li>
      <div
        className={`${styles.fileItem} ${isActive ? styles.active : ''}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={() => {
          if (isDir) {
            setExpanded(!effectivelyExpanded)
          } else {
            onSelect(file)
          }
        }}
      >
        {isDir ? (
          <span className={styles.fileIcon}>{effectivelyExpanded ? '\u{1F4C2}' : '\u{1F4C1}'}</span>
        ) : (
          <span className={styles.fileIcon}>{getFileIcon(file.name)}</span>
        )}
        <span className={styles.fileName}>{file.name}</span>
        {!isDir && <span className={styles.fileSize}>{formatSize(file.size)}</span>}
      </div>
      {isDir && effectivelyExpanded && file.children && (
        <ul className={styles.dirChildren}>
          {file.children.map((child) => (
            <FileTreeNode
              key={child.path}
              file={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
              forceExpand={forceExpand}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
