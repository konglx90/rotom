import { useState, useEffect, useCallback, useMemo } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { artifactsApi, type ArtifactRefs } from '../../../api/artifacts'
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
import { BranchDiffView } from './BranchDiffView'
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
  const { treeWidth, treeDragging, setTreeDragging, treeDragStartRef, resetTreeWidth } = useTreeResize()

  // VSCode 调起态:loading 防双击,error 展示 master 侧 spawn 失败原因
  // (主要是 `code` 不在 PATH)。visitor 模式下 POST 走不通,直接隐藏入口。
  const { isVisitor } = useVisitorMode()
  const [vscodeLoading, setVscodeLoading] = useState(false)
  const [vscodeError, setVscodeError] = useState<string | null>(null)

  // groupWorktree:VSCode 下拉 + 分支对比模式共用,由 groupId effect 加载。
  // 分支对比的 13 个 state 已移入 BranchDiffView(随 mode 切换卸载重置)。
  const [groupWorktree, setGroupWorktree] = useState<GroupWorktreeInfo | null>(null)

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
    // 切群时清空 groupWorktree(VSCode 下拉 + 分支对比用);分支对比状态随 BranchDiffView 卸载重置。
    setGroupWorktree(null)
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

  // 进入分支对比:仅切 mode;groupWorktree 由 groupId effect 加载,
  // refs 拉取 + branchDiff 状态管理都在 BranchDiffView 内(mount effect)。
  const enterBranchDiff = useCallback(() => setMode('branchDiff'), [])

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
            onDoubleClick={resetTreeWidth}
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
