import { useState, useEffect, useCallback, useMemo } from 'react'
import { artifactsApi } from '../../../api/artifacts'
import { reposApi, type GroupWorktreeInfo } from '../../../api/repos'
import type { ArtifactFile, ArtifactContent } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { TerminalPane } from '../TerminalPane'
import { findFileByPath } from './FileTree'
import { BranchDiffView } from './BranchDiffView'
import { ArtifactPreview } from './ArtifactPreview'
import { ArtifactTree } from './ArtifactTree'
import { PathBar } from './PathBar'
import { VscodeMenu } from './VscodeMenu'
import { useTreeResize } from './useTreeResize'
import { useMonaco } from '../../../hooks/useMonaco'
import { useVisitorMode } from '../../../context/VisitorContext'
import styles from './ArtifactPanel.module.css'

interface ArtifactPanelProps {
  groupId: string
  /** 受控选中路径:外部(如 Issue 详情里的 artifact 链接)传入时,面板自动
   *  选中并加载该文件。null/undefined 时走面板内部选中态。
   *  与内部点击树节点的双向同步:onSelectedPathChange 把内部选中反向通知
   *  外部;外部不回写就不会形成循环(useEffect 依赖 [selectedPath] 不变即跳过)。 */
  selectedPath?: string | null
  onSelectedPathChange?: (path: string | null) => void
}

export function ArtifactPanel({ groupId, selectedPath, onSelectedPathChange }: ArtifactPanelProps) {
  const [root, setRoot] = useState<string | null>(null)
  const [files, setFiles] = useState<ArtifactFile[]>([])
  const [selectedFile, setSelectedFile] = useState<ArtifactFile | null>(null)
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [contentLoading, setContentLoading] = useState(false)
  const [copiedHint, setCopiedHint] = useState(false)
  const [mode, setMode] = useState<'view' | 'diff' | 'branchDiff'>('view')
  // 文件树折叠态:折叠后只剩窄条(图标列),把空间让给预览。预览全屏看代码时有用。
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const { treeWidth, treeDragging, setTreeDragging, treeDragStartRef, resetTreeWidth } = useTreeResize()

  // VSCode 调起态:loading 防双击,error 展示 master 侧 spawn 失败原因
  // (主要是 `code` 不在 PATH)。visitor 模式下 POST 走不通,直接隐藏入口。
  const { isVisitor } = useVisitorMode()
  const [vscodeLoading, setVscodeLoading] = useState(false)
  const [vscodeError, setVscodeError] = useState<string | null>(null)

  // groupWorktree:VSCode 下拉 + 分支对比模式共用,由 groupId effect 加载。
  // 分支对比的 13 个 state 已移入 BranchDiffView(随 mode 切换卸载重置)。
  const [groupWorktree, setGroupWorktree] = useState<GroupWorktreeInfo | null>(null)

  const { ready: monacoReady } = useMonaco()

  const loadFiles = useCallback(async () => {
    try {
      setLoading(true)
      const data = await artifactsApi.list(groupId)
      setRoot(data.root)
      setFiles(data.files ?? [])
    } catch (err) {
      console.error('Failed to load artifacts:', err)
    } finally {
      setLoading(false)
    }
  }, [groupId])

  useEffect(() => {
    loadFiles()
    setSelectedFile(null)
    setContent(null)
    setMode('view')
    // 切群时清空 groupWorktree(VSCode 下拉 + 分支对比用);分支对比状态随 BranchDiffView 卸载重置。
    setGroupWorktree(null)
    // groupWorktree 给 header 的「VSCode 打开」下拉用(列出 primary + extras
    // 各仓库目录)。失败不阻塞,下拉里只显示「产物目录」一项。
    reposApi.getGroupWorktree(groupId).then(setGroupWorktree).catch(() => setGroupWorktree(null))
  }, [groupId, loadFiles])

  const handleSelect = useCallback(async (file: ArtifactFile) => {
    setSelectedFile(file)
    setContentLoading(true)
    setMode('view')
    // 双向同步:把内部选中反向通知外部,外部 state 不回写就不会形成循环
    // (useEffect 依赖 selectedPath,相同值不触发)。
    // original/viewMode 的重置由 ArtifactPreview 的 [selectedFile] effect 接管。
    onSelectedPathChange?.(file.path)
    try {
      const data = await artifactsApi.getContent(groupId, file.path)
      setContent(data)
    } catch (err) {
      console.error('Failed to load file content:', err)
      setContent(null)
    } finally {
      setContentLoading(false)
    }
  }, [groupId, onSelectedPathChange])

  // 外部受控 selectedPath 变化时(例如 Issue 详情点击 artifact 链接),
  // 在文件树里找到节点并触发选中。files 还没加载完时跳过,等加载完再跑。
  // selectedFile 已对齐 selectedPath 时跳过,避免与内部点击形成循环。
  useEffect(() => {
    if (!selectedPath) return
    if (files.length === 0) return
    if (selectedFile?.path === selectedPath) return
    const target = findFileByPath(files, selectedPath)
    if (!target) return
    void handleSelect(target)
  }, [selectedPath, files, selectedFile, handleSelect])

  // 拼接 working_dir(root) + 选中文件相对路径 → 完整绝对路径。
  // 优先用后端返回的 absPath(权威),拿不到就客户端拼。
  const absolutePath = useMemo(() => {
    if (!selectedFile || !root) return ''
    if (selectedFile.absPath) return selectedFile.absPath
    const sep = root.endsWith('/') ? '' : '/'
    return `${root}${sep}${selectedFile.path}`
  }, [selectedFile, root])

  const handleCopyPath = useCallback(async () => {
    if (!selectedFile) return
    const text = absolutePath || selectedFile.path
    try {
      await navigator.clipboard.writeText(text)
      setCopiedHint(true)
      window.setTimeout(() => setCopiedHint(false), 1500)
    } catch {
      // 浏览器拒绝(常见:非 HTTPS / iframe 无权限)。降级提示用户手拷。
      setCopiedHint(false)
    }
  }, [selectedFile, absolutePath])

  // 调起 master 本机 VSCode。传 selectedFile.path(虚拟路径,后端自识别
  // `__repos/` 前缀);不传 path 则打开 group artifacts 根目录。
  // repo 参数把 base 切到对应 worktree(用于 header 下拉里"开仓库目录")。
  const handleOpenVscode = useCallback(async (filePath?: string, repo?: string) => {
    if (vscodeLoading) return
    setVscodeLoading(true)
    setVscodeError(null)
    try {
      await artifactsApi.openVscode(groupId, filePath, repo)
    } catch (err) {
      setVscodeError(err instanceof Error ? err.message : String(err))
    } finally {
      setVscodeLoading(false)
    }
  }, [groupId, vscodeLoading])

  // 进入分支对比:仅切 mode;groupWorktree 由 groupId effect 加载,
  // refs 拉取 + branchDiff 状态管理都在 BranchDiffView 内(mount effect)。
  const enterBranchDiff = useCallback(() => setMode('branchDiff'), [])

  return (
    <div className={styles.artifactPanel}>
      <div className={styles.artifactHeader}>
        <h3 className={styles.artifactTitle}>{'\u{1F4E6}'} Artifacts & Repos</h3>
        <div className={styles.previewActions}>
          {mode === 'branchDiff' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMode('view')}
              title="回到查看模式"
            >
              返回查看
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setTreeCollapsed((v) => !v)}
                title={treeCollapsed ? '展开文件树' : '收起文件树(让位给预览)'}
              >
                {treeCollapsed ? '\u{25C0}' : '\u{25B6}'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={enterBranchDiff}
                title="对比两个 ref 之间的所有变更文件(支持 primary 与各 extra repo)"
              >
                分支对比
              </Button>
              {!isVisitor && (
                <VscodeMenu
                  groupWorktree={groupWorktree}
                  vscodeLoading={vscodeLoading}
                  root={root}
                  onOpenVscode={handleOpenVscode}
                />
              )}
              <Button variant="ghost" size="sm" onClick={loadFiles}>
                刷新
              </Button>
            </>
          )}
        </div>
      </div>
      {root && (
        <PathBar
          root={root}
          selectedFile={selectedFile}
          absolutePath={absolutePath}
          vscodeError={vscodeError}
          isVisitor={isVisitor}
          vscodeLoading={vscodeLoading}
          onOpenVscode={handleOpenVscode}
          onCopyPath={handleCopyPath}
          copiedHint={copiedHint}
          onClose={() => { setSelectedFile(null); setContent(null); setMode('view'); onSelectedPathChange?.(null) }}
        />
      )}

      {/* 分支对比模式:顶部 repo + base + head 选择器,右变更文件列表,
          左 DiffEditor 展示 base..head 的单文件 diff。和单文件 diff(mode='diff')
          独立,不复用 selectedFile/content/original 这套状态。 */}
      {mode === 'branchDiff' ? (
        <BranchDiffView
          groupId={groupId}
          groupWorktree={groupWorktree}
          monacoReady={monacoReady}
          treeWidth={treeWidth}
          treeDragging={treeDragging}
          treeDragStartRef={treeDragStartRef}
          setTreeDragging={setTreeDragging}
          resetTreeWidth={resetTreeWidth}
        />
      ) : (
      <div className={styles.splitLayout}>
        <ArtifactTree
          files={files}
          loading={loading}
          root={root}
          selectedFilePath={selectedFile?.path ?? null}
          onSelect={handleSelect}
          treeCollapsed={treeCollapsed}
          treeWidth={treeWidth}
          treeDragging={treeDragging}
          treeDragStartRef={treeDragStartRef}
          setTreeDragging={setTreeDragging}
          resetTreeWidth={resetTreeWidth}
        />

        <ArtifactPreview
          groupId={groupId}
          selectedFile={selectedFile}
          content={content}
          contentLoading={contentLoading}
          mode={mode}
          setMode={setMode}
          monacoReady={monacoReady}
        />
      </div>
      )}

      <TerminalPane groupId={groupId} />
    </div>
  )
}
