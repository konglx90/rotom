// 分支对比模式:选 repo + base ref + head ref → 整段分支 diff。
// 独立于单文件 diff(mode='diff'),不复用 selectedFile/content/original。
// 自包含:13 个 branchDiff state + 4 个 handler 都在这里;mount 时(groupWorktree
// 就绪后)拉 refs。tree 拖拽态由父组件共享传入(与查看模式共用一个 treeWidth)。
import { useCallback, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { artifactsApi, type ArtifactRefs, type BranchDiffFile, type BranchDiffResponse } from '../../../api/artifacts'
import type { GroupWorktreeInfo } from '../../../api/repos'
import { Select } from '../../../components/ui/Select'
import { Button } from '../../../components/ui/Button'
import { RefSelector, repoDisplayName, STATUS_LABEL, STATUS_COLOR } from './BranchDiffControls'
import { detectLanguage } from './artifactFileUtils'
import styles from './ArtifactPanel.module.css'

interface BranchDiffViewProps {
  groupId: string
  groupWorktree: GroupWorktreeInfo | null
  monacoReady: boolean
  treeWidth: number
  treeDragging: boolean
  treeDragStartRef: React.MutableRefObject<{ x: number; w: number } | null>
  setTreeDragging: (v: boolean) => void
  resetTreeWidth: () => void
}

export function BranchDiffView({
  groupId,
  groupWorktree,
  monacoReady,
  treeWidth,
  treeDragging,
  treeDragStartRef,
  setTreeDragging,
  resetTreeWidth,
}: BranchDiffViewProps) {
  const [branchDiffRepo, setBranchDiffRepo] = useState<string>('primary')
  const [branchDiffBase, setBranchDiffBase] = useState<string>('')
  const [branchDiffHead, setBranchDiffHead] = useState<string>('')
  // 选中的 repo 对应的 refs(切 repo 时重新拉,base/head 下拉要用)。
  const [branchDiffRefs, setBranchDiffRefs] = useState<ArtifactRefs | null>(null)
  const [branchDiffRefsLoading, setBranchDiffRefsLoading] = useState(false)
  // base..head 之间的变更文件清单 + 统计。
  const [branchDiffResult, setBranchDiffResult] = useState<BranchDiffResponse | null>(null)
  const [branchDiffLoading, setBranchDiffLoading] = useState(false)
  const [branchDiffError, setBranchDiffError] = useState<string | null>(null)
  // 当前选中的变更文件(branchDiffResult.files 里的一项)。
  const [branchDiffSelected, setBranchDiffSelected] = useState<BranchDiffFile | null>(null)
  // 选中文件 base 侧 / head 侧 的内容(并行调 content-at-ref 取)。
  const [branchDiffOriginal, setBranchDiffOriginal] = useState<string | null>(null)
  const [branchDiffModified, setBranchDiffModified] = useState<string | null>(null)
  const [branchDiffFileLoading, setBranchDiffFileLoading] = useState(false)
  const [branchDiffFileError, setBranchDiffFileError] = useState<string | null>(null)

  // ─── 分支对比 handlers ───────────────────────────────────────────────
  // repo 列表从 reposApi.getGroupWorktree 拿(primary + extras),每次进
  // branchDiff 模式时刷新一次,保证 extras 增删及时反映。切 repo 时重拉
  // 该 repo 的 refs,base/head 默认值也跟着重置(repo.branch 作 base、HEAD 作 head)。
  const loadBranchDiffRefs = useCallback(async (repo: string) => {
    setBranchDiffRefsLoading(true)
    setBranchDiffRefs(null)
    try {
      const data = await artifactsApi.listRefs(groupId, repo)
      setBranchDiffRefs(data)
      // 首次进入或切 repo 时,base 默认用 group 配的 default branch(master/main),
      // head 默认用该 repo 当前 checkout 的分支(refs.head)。空值留作 HEAD。
      setBranchDiffBase((prev) => {
        if (prev !== '') return prev
        // primary 用 groupWorktree.branch;extras 用 extra 自己的 branch 字段
        if (repo === 'primary') return groupWorktree?.branch || ''
        const extra = groupWorktree?.extras.find((e) => e.id === repo)
        return extra?.branch || ''
      })
      setBranchDiffHead((prev) => (prev !== '' ? prev : data.head || ''))
    } catch (err) {
      console.error('Failed to load refs for repo:', repo, err)
      setBranchDiffRefs(null)
    } finally {
      setBranchDiffRefsLoading(false)
    }
  }, [groupId, groupWorktree])

  // mount / groupWorktree 就绪后拉一次 refs(复刻原 enterBranchDiff 里
  // 「groupWorktree 就绪后再 loadBranchDiffRefs」的时序)。groupWorktree 由
  // 父组件的 groupId effect 加载,作为 prop 传入;切群时本组件随 mode→'view'
  // 卸载,branchDiff 状态自然重置,无需手动清。
  useEffect(() => {
    if (!groupWorktree) return
    void loadBranchDiffRefs(branchDiffRepo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupWorktree])

  // 切 repo:重置 base/head/result/选中文件,并重拉 refs。
  const handleBranchDiffRepoChange = useCallback((repo: string) => {
    setBranchDiffRepo(repo)
    setBranchDiffBase('')
    setBranchDiffHead('')
    setBranchDiffResult(null)
    setBranchDiffSelected(null)
    setBranchDiffOriginal(null)
    setBranchDiffModified(null)
    setBranchDiffError(null)
    setBranchDiffFileError(null)
    void loadBranchDiffRefs(repo)
  }, [loadBranchDiffRefs])

  const handleBranchDiff = useCallback(async () => {
    setBranchDiffLoading(true)
    setBranchDiffError(null)
    setBranchDiffResult(null)
    setBranchDiffSelected(null)
    setBranchDiffOriginal(null)
    setBranchDiffModified(null)
    setBranchDiffFileError(null)
    try {
      const data = await artifactsApi.branchDiff(
        groupId,
        branchDiffRepo,
        branchDiffBase || 'HEAD',
        branchDiffHead || 'HEAD',
      )
      setBranchDiffResult(data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Failed to load branch diff:', err)
      setBranchDiffError(msg)
    } finally {
      setBranchDiffLoading(false)
    }
  }, [groupId, branchDiffRepo, branchDiffBase, branchDiffHead])

  const handleSelectBranchDiffFile = useCallback(async (file: BranchDiffFile) => {
    if (!branchDiffResult) return
    setBranchDiffSelected(file)
    setBranchDiffOriginal(null)
    setBranchDiffModified(null)
    setBranchDiffFileError(null)
    setBranchDiffFileLoading(true)
    const baseRef = branchDiffBase || 'HEAD'
    const headRef = branchDiffHead || 'HEAD'
    // 用 fromPath(重命名场景)作为 base 侧路径,新路径作为 head 侧路径。
    // 对 M/A 文件 fromPath 不存在,两侧都用 path。
    const basePath = file.fromPath || file.path
    try {
      const [baseContent, headContent] = await Promise.all([
        artifactsApi.getContentAtRef(groupId, branchDiffRepo, basePath, baseRef),
        artifactsApi.getContentAtRef(groupId, branchDiffRepo, file.path, headRef),
      ])
      setBranchDiffOriginal(baseContent.content)
      setBranchDiffModified(headContent.content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Failed to load branch diff file content:', err)
      setBranchDiffFileError(msg)
    } finally {
      setBranchDiffFileLoading(false)
    }
  }, [groupId, branchDiffRepo, branchDiffBase, branchDiffHead, branchDiffResult])

  return (
    <div className={styles.splitLayout}>
      <div
        className={styles.treePane}
        style={{ width: `${treeWidth}px`, flex: `0 0 ${treeWidth}px` }}
      >
        {/* toolbar 行 1:repo 选择器 */}
        <div className={styles.searchRow} style={{ flexWrap: 'wrap', gap: 4 }}>
          <Select
            className={styles.diffBaseSelect}
            size="sm"
            value={branchDiffRepo}
            onChange={(e) => handleBranchDiffRepoChange(e.target.value)}
            title="选择仓库(primary 或 extra repos)"
            disabled={!groupWorktree}
          >
            {!groupWorktree && <option value="">加载中…</option>}
            {groupWorktree && (
              <option value="primary">
                primary · {repoDisplayName(groupWorktree.url)}{groupWorktree.primaryExists ? '' : ' (未创建)'}
              </option>
            )}
            {groupWorktree?.extras.map((e) => (
              <option key={e.id} value={e.id} disabled={!e.exists}>
                {e.id} · {repoDisplayName(e.url)}{e.exists ? '' : ' (未创建)'}
              </option>
            ))}
          </Select>
        </div>
        {/* toolbar 行 2:base + head ref 选择器 + 对比按钮 */}
        <div className={styles.searchRow} style={{ flexWrap: 'wrap', gap: 4, paddingTop: 4 }}>
          <RefSelector
            value={branchDiffBase}
            onChange={setBranchDiffBase}
            onEnter={handleBranchDiff}
            refs={branchDiffRefs}
            placeholder="base: 分支/tag/commit"
            title="base ref(通常是 master/main)"
          />
          <RefSelector
            value={branchDiffHead}
            onChange={setBranchDiffHead}
            onEnter={handleBranchDiff}
            refs={branchDiffRefs}
            placeholder="head: 分支/tag/commit"
            title="head ref(待 review 的迭代分支)"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleBranchDiff}
            disabled={branchDiffLoading || branchDiffRefsLoading}
          >
            {branchDiffLoading ? '加载中...' : '对比'}
          </Button>
        </div>
        {/* 变更文件列表 */}
        {branchDiffLoading ? (
          <div className={styles.loadingText}>加载中...</div>
        ) : branchDiffError ? (
          <div className={styles.diffNote}>对比失败: {branchDiffError}</div>
        ) : !branchDiffResult ? (
          <div className={styles.artifactEmpty}>
            <div>
              <p>选择 base / head 后点「对比」</p>
              <p style={{ fontSize: 12, marginTop: 4 }}>
                {branchDiffRefsLoading ? '正在加载 refs…' : ''}
              </p>
            </div>
          </div>
        ) : branchDiffResult.files.length === 0 ? (
          <div className={styles.artifactEmpty}>
            <p><code>{branchDiffResult.base}</code> → <code>{branchDiffResult.head}</code> 之间无变更</p>
          </div>
        ) : (
          <>
            <div className={styles.searchRow} style={{ color: 'var(--color-slate)', paddingTop: 4 }}>
              {branchDiffResult.stats.filesChanged} 文件 / +{branchDiffResult.stats.additions} -{branchDiffResult.stats.deletions}
              {branchDiffResult.truncated && <span style={{ color: 'var(--color-amber, #b8860b)' }}> · 已截断前 500</span>}
            </div>
            <ul className={styles.fileTree}>
              {branchDiffResult.files.map((f) => {
                const active = branchDiffSelected?.path === f.path
                const label = f.fromPath ? `${f.fromPath} → ${f.path}` : f.path
                const fileName = label.split('/').pop() || label
                const dirPart = label.slice(0, label.length - fileName.length)
                return (
                  <li key={`${f.status}:${f.path}`}>
                    <div
                      className={`${styles.fileItem} ${active ? styles.active : ''}`}
                      title={label}
                      onClick={() => handleSelectBranchDiffFile(f)}
                    >
                      <span
                        className={styles.fileIcon}
                        style={{
                          color: STATUS_COLOR[f.status] || '#666',
                          fontWeight: 700,
                          fontSize: 11,
                          minWidth: 14,
                          textAlign: 'center',
                        }}
                        title={STATUS_LABEL[f.status] || f.status}
                      >
                        {f.status}
                      </span>
                      <span className={styles.fileName}>
                        {dirPart && <span style={{ opacity: 0.55 }}>{dirPart}</span>}
                        {fileName}
                      </span>
                      <span className={styles.fileSize}>+{f.additions} -{f.deletions}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      <div
        className={`${styles.treeResizer} ${treeDragging ? styles.treeResizerActive : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          treeDragStartRef.current = { x: e.clientX, w: treeWidth }
          setTreeDragging(true)
        }}
        onDoubleClick={resetTreeWidth}
        title="拖拽调整宽度,双击恢复默认"
      />
      {/* 左:DiffEditor 展示 base vs head */}
      <div className={styles.previewPane}>
        {branchDiffSelected ? (
          <div className={styles.previewSection}>
            <div className={styles.previewHeader}>
              <div className={styles.previewHeaderBottom}>
                <div className={styles.diffHeader}>
                  <code>{branchDiffSelected.path}</code>
                  {' · '}
                  <code>{branchDiffBase || 'HEAD'}</code> → <code>{branchDiffHead || 'HEAD'}</code>
                  {branchDiffSelected.fromPath && (
                    <span className={styles.diffRepo}> (renamed from {branchDiffSelected.fromPath})</span>
                  )}
                </div>
              </div>
            </div>
            {branchDiffFileLoading ? (
              <div className={styles.loadingText}>加载中...</div>
            ) : branchDiffFileError ? (
              <div className={styles.diffNote}>加载文件内容失败: {branchDiffFileError}</div>
            ) : !monacoReady ? (
              <div className={styles.loadingText}>编辑器加载中...</div>
            ) : (
              <div className={styles.editorWrap}>
                <DiffEditor
                  height="100%"
                  language={detectLanguage(branchDiffSelected.path)}
                  original={branchDiffOriginal ?? ''}
                  modified={branchDiffModified ?? ''}
                  theme="vs"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    renderSideBySide: true,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: 'on',
                  }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className={styles.previewEmpty}>
            <div className={styles.previewEmptyIcon}>{'\u{1F50D}'}</div>
            <p>从右侧选择变更文件查看 diff</p>
            <p className={styles.previewEmptyHint}>
              选择 repo + base + head 后点「对比」,再从变更列表选文件
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
