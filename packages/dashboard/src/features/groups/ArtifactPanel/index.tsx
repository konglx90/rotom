import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { artifactsApi, type ArtifactRefs, type BranchDiffFile, type BranchDiffResponse } from '../../../api/artifacts'
import { reposApi, type GroupWorktreeInfo } from '../../../api/repos'
import type { ArtifactFile, ArtifactContent, ArtifactOriginal } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import { Input } from '../../../components/ui/Input'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import { Select } from '../../../components/ui/Select'
import { TerminalPane } from '../TerminalPane'
import { formatSize, detectLanguage, isMarkdownPath, isImagePath, buildImageDataUrl } from './artifactFileUtils'
import { ImagePreview } from './ImagePreview'
import { FileTreeNode, findFileByPath } from './FileTree'
import { repoDisplayName, STATUS_LABEL, STATUS_COLOR, RefSelector } from './BranchDiffControls'
import { VscodeMenu } from './VscodeMenu'
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

/** 文件树宽度约束:深目录需要更宽才不截断文件名,但也不能把预览挤没了。
 *  用户拖动分隔条后宽度持久化到 localStorage,下次进面板恢复。 */
const TREE_WIDTH_DEFAULT = 260
const TREE_WIDTH_MIN = 180
const TREE_WIDTH_MAX = 520
const TREE_WIDTH_STORAGE_KEY = 'rotom-artifact-tree-width'

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

export function ArtifactPanel({ groupId, selectedPath, onSelectedPathChange }: ArtifactPanelProps) {
  const [root, setRoot] = useState<string | null>(null)
  const [files, setFiles] = useState<ArtifactFile[]>([])
  const [selectedFile, setSelectedFile] = useState<ArtifactFile | null>(null)
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [contentLoading, setContentLoading] = useState(false)
  const [original, setOriginal] = useState<ArtifactOriginal | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffBase, setDiffBase] = useState<string>('')
  const [refs, setRefs] = useState<ArtifactRefs | null>(null)
  const [search, setSearch] = useState('')
  const [copiedHint, setCopiedHint] = useState(false)
  const [mode, setMode] = useState<'view' | 'diff' | 'branchDiff'>('view')
  // 文件树折叠态:折叠后只剩窄条(图标列),把空间让给预览。预览全屏看代码时有用。
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  // 文件树宽度:可拖拽分隔条调整,持久化到 localStorage。深目录默认 260,
  // 用户拖宽后下次进面板保留。treeCollapsed=true 时强制 0(分隔条也隐藏)。
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(TREE_WIDTH_STORAGE_KEY)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n >= TREE_WIDTH_MIN && n <= TREE_WIDTH_MAX ? n : TREE_WIDTH_DEFAULT
    } catch {
      return TREE_WIDTH_DEFAULT
    }
  })
  const [treeDragging, setTreeDragging] = useState(false)
  const treeDragStartRef = useRef<{ x: number; w: number } | null>(null)

  // VSCode 调起态:loading 防双击,error 展示 master 侧 spawn 失败原因
  // (主要是 `code` 不在 PATH)。visitor 模式下 POST 走不通,直接隐藏入口。
  const { isVisitor } = useVisitorMode()
  const [vscodeLoading, setVscodeLoading] = useState(false)
  const [vscodeError, setVscodeError] = useState<string | null>(null)

  // ─── 分支对比模式 state ───────────────────────────────────────────────
  // 独立于单文件 diff(mode='diff')的单文件 → DiffEditor 流程,这里走的是
  // 「选 repo + base ref + head ref → 整段分支 diff」的分支级流程。
  const [groupWorktree, setGroupWorktree] = useState<GroupWorktreeInfo | null>(null)
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
  // 选中文件 base 侧 / head 侧的内容(并行调 content-at-ref 取)。
  const [branchDiffOriginal, setBranchDiffOriginal] = useState<string | null>(null)
  const [branchDiffModified, setBranchDiffModified] = useState<string | null>(null)
  const [branchDiffFileLoading, setBranchDiffFileLoading] = useState(false)
  const [branchDiffFileError, setBranchDiffFileError] = useState<string | null>(null)

  useEffect(() => {
    if (!treeDragging) return
    const onMove = (e: MouseEvent) => {
      const start = treeDragStartRef.current
      if (!start) return
      // 目录树靠右:向左拖(.clientX 减小)才应让树变宽,故 delta 取反。
      const next = Math.max(
        TREE_WIDTH_MIN,
        Math.min(TREE_WIDTH_MAX, start.w - (e.clientX - start.x)),
      )
      setTreeWidth(next)
      // 同步写盘:localStorage 单 key 写很快,不必搞 debounce
      try { localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(next)) } catch { /* ignore */ }
    }
    const onUp = () => setTreeDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [treeDragging])
  // MD 文件默认渲染成 HTML,viewMode='source' 时回退到 Monaco markdown 高亮。
  // 切换非 MD 文件时自动重置回 preview(对 MD 无影响,对后续切回 MD 生效)。
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')
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
    setOriginal(null)
    setMode('view')
    // 切群时清空分支对比状态(都是群特定数据)
    setGroupWorktree(null)
    setBranchDiffRepo('primary')
    setBranchDiffBase('')
    setBranchDiffHead('')
    setBranchDiffRefs(null)
    setBranchDiffResult(null)
    setBranchDiffSelected(null)
    setBranchDiffOriginal(null)
    setBranchDiffModified(null)
    // refs 加载失败不阻塞主流程,下拉退化为只剩 HEAD 选项
    artifactsApi.listRefs(groupId).then(setRefs).catch(() => setRefs(null))
    // groupWorktree 给 header 的「VSCode 打开」下拉用(列出 primary + extras
    // 各仓库目录)。失败不阻塞,下拉里只显示「产物目录」一项。
    reposApi.getGroupWorktree(groupId).then(setGroupWorktree).catch(() => setGroupWorktree(null))
  }, [groupId, loadFiles])

  const handleSelect = useCallback(async (file: ArtifactFile) => {
    setSelectedFile(file)
    setContentLoading(true)
    setOriginal(null)
    setMode('view')
    setViewMode('preview')
    // 双向同步:把内部选中反向通知外部,外部 state 不回写就不会形成循环
    // (useEffect 依赖 selectedPath,相同值不触发)。
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

  const filteredFiles = useMemo(() => filterFilesByName(files, search), [files, search])
  const searching = search.trim().length > 0

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

  const handleDiff = async () => {
    if (!selectedFile) return
    setDiffLoading(true)
    try {
      const data = await artifactsApi.getOriginal(groupId, selectedFile.path, diffBase || 'HEAD')
      setOriginal(data)
      setMode('diff')
    } catch (err) {
      console.error('Failed to load original:', err)
      setOriginal({
        path: selectedFile.path, base: diffBase, repoRoot: null, content: '',
        note: `获取原始内容失败: ${err instanceof Error ? err.message : String(err)}`,
      })
      setMode('diff')
    } finally {
      setDiffLoading(false)
    }
  }

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

  const enterBranchDiff = useCallback(async () => {
    setMode('branchDiff')
    setBranchDiffResult(null)
    setBranchDiffSelected(null)
    setBranchDiffOriginal(null)
    setBranchDiffModified(null)
    setBranchDiffError(null)
    setBranchDiffFileError(null)
    // 拉 groupWorktree(若已拉过则复用,避免每次进入都打接口)
    if (!groupWorktree) {
      try {
        const data = await reposApi.getGroupWorktree(groupId)
        setGroupWorktree(data)
      } catch (err) {
        console.error('Failed to load group worktree info:', err)
      }
    }
    void loadBranchDiffRefs(branchDiffRepo)
  }, [groupId, groupWorktree, branchDiffRepo, loadBranchDiffRefs])

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

  const language = useMemo(
    () => (selectedFile ? detectLanguage(selectedFile.path) : 'plaintext'),
    [selectedFile],
  )

  const isMarkdown = selectedFile ? isMarkdownPath(selectedFile.path) : false
  const isImage = selectedFile ? isImagePath(selectedFile.path) : false
  // 图片走 ImagePreview,不进 Monaco 通道;但后端对 svg 返回 text,对其他
  // 图片返回 binary。这里统一看后缀判断,真正解码在 buildImageDataUrl。
  const imageDataUrl = useMemo(
    () => (isImage && content ? buildImageDataUrl(selectedFile!.path, content) : null),
    [isImage, content, selectedFile],
  )
  // 后端图片走 binary + base64,但 SVG 走 text 通道。SVG 以外但 type=text
  // 的"图片"是异常,降级到二进制提示。
  const imageUnsupported = isImage && !imageDataUrl

  const previewBinary = content?.type === 'binary' && !isImage

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
        <div className={styles.pathBar}>
          <span className={styles.pathBarPath} title={selectedFile ? absolutePath : root}>
            {selectedFile ? absolutePath : root}
          </span>
          {selectedFile && (
            <div className={styles.pathBarActions}>
              {vscodeError && (
                <span className={styles.vscodeError} title={vscodeError}>{vscodeError}</span>
              )}
              {!isVisitor && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpenVscode(selectedFile.path)}
                  disabled={vscodeLoading}
                  title="在 master 本机用 VSCode 打开该文件"
                >
                  {vscodeLoading ? 'VSCode…' : 'VSCode'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyPath}
                title="复制绝对路径"
              >
                {copiedHint ? '已复制' : '复制'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setSelectedFile(null); setContent(null); setOriginal(null); setMode('view'); onSelectedPathChange?.(null) }}
                title="关闭预览"
              >
                关闭
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 分支对比模式:顶部 repo + base + head 选择器,右变更文件列表,
          左 DiffEditor 展示 base..head 的单文件 diff。和单文件 diff(mode='diff')
          独立,不复用 selectedFile/content/original 这套状态。 */}
      {mode === 'branchDiff' ? (
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
            onDoubleClick={() => {
              setTreeWidth(TREE_WIDTH_DEFAULT)
              try { localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(TREE_WIDTH_DEFAULT)) } catch { /* ignore */ }
            }}
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
      ) : (
      <div className={styles.splitLayout}>
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
                  selectedPath={selectedFile?.path ?? null}
                  onSelect={handleSelect}
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
            onDoubleClick={() => {
              setTreeWidth(TREE_WIDTH_DEFAULT)
              try { localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(TREE_WIDTH_DEFAULT)) } catch { /* ignore */ }
            }}
            title="拖拽调整目录树宽度,双击恢复默认"
          />
        )}

        <div className={styles.previewPane}>
      {selectedFile && (
        <div className={styles.previewSection}>
          <div className={styles.previewHeader}>
            <div className={styles.previewHeaderBottom}>
              {mode === 'diff' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMode('view')}
                  title="回到查看模式"
                >
                  查看
                </Button>
              ) : (
                <>
                  {isMarkdown && (
                    <div className={styles.viewModeToggle} role="group" aria-label="预览模式">
                      <button
                        type="button"
                        className={`${styles.viewModeBtn} ${viewMode === 'preview' ? styles.viewModeBtnActive : ''}`}
                        onClick={() => setViewMode('preview')}
                      >
                        渲染
                      </button>
                      <button
                        type="button"
                        className={`${styles.viewModeBtn} ${viewMode === 'source' ? styles.viewModeBtnActive : ''}`}
                        onClick={() => setViewMode('source')}
                      >
                        源码
                      </button>
                    </div>
                  )}
                  <Select
                    className={styles.diffBaseSelect}
                    size="sm"
                    value={refs?.heads.includes(diffBase) || diffBase === '' || diffBase === 'HEAD' ? diffBase : '__custom__'}
                    onChange={e => {
                      const v = e.target.value
                      if (v === '__custom__') return // 用户选了"自定义",保留当前 input 值
                      setDiffBase(v)
                    }}
                    title="选择常用 git ref(分支/tag/HEAD)"
                  >
                    <option value="">HEAD(默认)</option>
                    {refs?.heads.map(r => (
                      <option key={r} value={r}>
                        {r}{r === refs.head ? ' (当前)' : ''}
                      </option>
                    ))}
                    {refs && refs.tags.length > 0 && (
                      <optgroup label="tags">
                        {refs.tags.map(t => (
                          <option key={t} value={`tags/${t}`}>{t}</option>
                        ))}
                      </optgroup>
                    )}
                    {!refs?.note && refs && refs.refs.length === 0 && (
                      <option value="" disabled>仓库无分支</option>
                    )}
                    {refs?.note && (
                      <option value="" disabled>{refs.note}</option>
                    )}
                    <option value="__custom__">自定义…</option>
                  </Select>
                  <Input
                    className={styles.diffBaseInput}
                    size="sm"
                    value={diffBase}
                    onChange={e => setDiffBase(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleDiff() }}
                    placeholder="commit / 分支 / tag"
                    title="对比基准 (git ref / commit / 分支),回车发起对比"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleDiff}
                    disabled={diffLoading}
                  >
                    {diffLoading ? '加载中...' : '对比'}
                  </Button>
                </>
              )}
            </div>
          </div>

          {contentLoading ? (
            <div className={styles.loadingText}>加载中...</div>
          ) : imageUnsupported ? (
            <div className={styles.diffNote}>图片格式不支持预览 ({formatSize(content!.size)})。</div>
          ) : isImage && imageDataUrl && content ? (
            <ImagePreview name={selectedFile.name} src={imageDataUrl} size={content.size} />
          ) : previewBinary ? (
            <div className={styles.diffNote}>二进制文件 ({formatSize(content!.size)})，无法直接预览。</div>
          ) : isMarkdown && viewMode === 'preview' && mode === 'view' && content ? (
            <div className={styles.mdPreviewWrap}>
              <MarkdownContent content={content.content} />
            </div>
          ) : !monacoReady ? (
            <div className={styles.loadingText}>编辑器加载中...</div>
          ) : mode === 'view' && content ? (
            <div className={styles.editorWrap}>
              <Editor
                height="100%"
                language={language}
                value={content.content}
                theme="vs"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  renderWhitespace: 'selection',
                  wordWrap: 'on',
                }}
              />
            </div>
          ) : mode === 'diff' && content && original ? (
            <>
              <div className={styles.diffHeader}>
                Diff vs <code>{original.base}</code>
                {original.repoRoot ? (
                  <span className={styles.diffRepo}> (repo: {original.repoRoot})</span>
                ) : null}
                {original.note ? <span className={styles.diffRepo}> · {original.note}</span> : null}
              </div>
              <div className={styles.editorWrap}>
                <DiffEditor
                  height="100%"
                  language={language}
                  original={original.content}
                  modified={content.content}
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
            </>
          ) : null}
        </div>
      )}
      {!selectedFile && (
        <div className={styles.previewEmpty}>
          <div className={styles.previewEmptyIcon}>{'\u{1F4C4}'}</div>
          <p>从右侧选择文件预览</p>
          <p className={styles.previewEmptyHint}>
            支持 .md 渲染、图片直接预览、Monaco 代码高亮、diff 对比
          </p>
        </div>
      )}
        </div>
      </div>
      )}

      <TerminalPane groupId={groupId} />
    </div>
  )
}
