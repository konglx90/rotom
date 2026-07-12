// 文件树窗格:搜索框 + FileTreeNode 列表 + 拖拽分隔条。
// 自包含 search 状态 + filteredFiles 派生。tree 拖拽态由父组件共享传入
// (与分支对比模式共用一个 treeWidth)。从 ArtifactPanel/index.tsx 抽出。
import { useMemo, useState } from 'react'
import type { ArtifactFile } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { FileTreeNode } from './FileTree'
import styles from './ArtifactPanel.module.css'

/** 按文件名过滤文件树:目录命中(自身或任一后代)则保留并裁掉不命中的
 *  子节点;文件命中则保留。空 query 返回原数组。大小写不敏感。 */
function filterFilesByName(files: ArtifactFile[], query: string): ArtifactFile[] {
  const q = query.trim().toLowerCase()
  if (!q) return files
  const walk = (nodes: ArtifactFile[]): ArtifactFile[] => {
    const out: ArtifactFile[] = []
    for (const node of nodes) {
      const selfMatch = node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)
      if (node.type === 'directory' && node.children) {
        const filteredChildren = walk(node.children)
        if (selfMatch || filteredChildren.length > 0) {
          out.push({ ...node, children: filteredChildren })
        }
      } else if (node.type === 'file' && selfMatch) {
        out.push(node)
      }
    }
    return out
  }
  return walk(files)
}

interface ArtifactTreeProps {
  files: ArtifactFile[]
  loading: boolean
  root: string | null
  selectedFilePath: string | null
  onSelect: (file: ArtifactFile) => void
  treeCollapsed: boolean
  treeWidth: number
  treeDragging: boolean
  treeDragStartRef: React.MutableRefObject<{ x: number; w: number } | null>
  setTreeDragging: (v: boolean) => void
  resetTreeWidth: () => void
}

export function ArtifactTree({
  files,
  loading,
  root,
  selectedFilePath,
  onSelect,
  treeCollapsed,
  treeWidth,
  treeDragging,
  treeDragStartRef,
  setTreeDragging,
  resetTreeWidth,
}: ArtifactTreeProps) {
  const [search, setSearch] = useState('')
  const filteredFiles = useMemo(() => filterFilesByName(files, search), [files, search])
  const searching = search.trim().length > 0

  return (
    <>
      <div
        className={`${styles.treePane} ${treeCollapsed ? styles.treePaneCollapsed : ''}`}
        style={treeCollapsed ? undefined : { width: `${treeWidth}px`, flex: `0 0 ${treeWidth}px` }}
      >
        {files.length > 0 && (
          <div className={styles.searchRow}>
            <Input
              className={styles.searchInput}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索文件名或路径…"
              type="search"
              autoComplete="off"
              spellCheck={false}
            />
            {searching && (
              <span className={styles.searchMeta}>
                {filteredFiles.length === 0 ? '无匹配' : `${filteredFiles.length} 项`}
              </span>
            )}
          </div>
        )}

        {loading ? (
          <div className={styles.loadingText}>加载中...</div>
        ) : files.length === 0 ? (
          <div className={styles.artifactEmpty}>
            <div>
              <p>暂无产物文件</p>
              <p style={{ fontSize: 12, marginTop: 4 }}>
                {root || '~/.rotom/artifacts/'}
              </p>
            </div>
          </div>
        ) : searching && filteredFiles.length === 0 ? (
          <div className={styles.artifactEmpty}>
            <div>
              <p>未找到匹配「{search}」的文件</p>
              <Button variant="ghost" size="sm" onClick={() => setSearch('')} style={{ marginTop: 8 }}>
                清空搜索
              </Button>
            </div>
          </div>
        ) : (
          <ul className={styles.fileTree}>
            {filteredFiles.map((file) => (
              <FileTreeNode
                key={file.path}
                file={file}
                selectedPath={selectedFilePath}
                onSelect={onSelect}
                depth={0}
                forceExpand={searching}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 拖拽分隔条:mouseDown 记起点,mousemove 由 useEffect 接管。
          双击恢复默认宽度。treeCollapsed 时隐藏(没东西可拖)。 */}
      {!treeCollapsed && (
        <div
          className={`${styles.treeResizer} ${treeDragging ? styles.treeResizerActive : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            treeDragStartRef.current = { x: e.clientX, w: treeWidth }
            setTreeDragging(true)
          }}
          onDoubleClick={resetTreeWidth}
          title="拖拽调整目录树宽度,双击恢复默认"
        />
      )}
    </>
  )
}
