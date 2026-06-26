import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { artifactsApi, type ArtifactRefs } from '../../api/artifacts'
import type { ArtifactFile, ArtifactContent, ArtifactOriginal } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { TerminalPane } from './TerminalPane'
import { useMonaco } from '../../hooks/useMonaco'
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

/** Depth at which directories are expanded by default on first load. */
const DEFAULT_EXPAND_DEPTH = 1

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', md: 'markdown', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', xml: 'xml', vue: 'html', svelte: 'html',
}

const MARKDOWN_RE = /\.(md|markdown)$/i
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i

/** 把后缀→MIME,只覆盖 ArtifactPanel 关心的图片类型。其他二进制
 *  (woff/pdf/zip) 仍然走"二进制文件无法预览"分支。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.module.css')) return 'css'
  const ext = lower.split('.').pop() || ''
  return LANG_BY_EXT[ext] || 'plaintext'
}

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_RE.test(filePath)
}

function isImagePath(filePath: string): boolean {
  return IMAGE_RE.test(filePath)
}

/** 把后端 base64 返回的图片内容解码成 data URL,失败时返回 null。SVG
 *  后端按文本返回(不在 binaryExts 里),这里也兜底支持。*/
function buildImageDataUrl(filePath: string, content: ArtifactContent): string | null {
  if (!isImagePath(filePath)) return null
  const ext = filePath.toLowerCase().split('.').pop() || ''
  const mime = IMAGE_MIME_BY_EXT[ext]
  if (!mime) return null
  if (content.type === 'binary') {
    return `data:${mime};base64,${content.content}`
  }
  // SVG 走 text 通道,直接 inline
  if (mime === 'image/svg+xml' && content.type === 'text') {
    return `data:${mime};utf8,${encodeURIComponent(content.content)}`
  }
  return null
}

/** 图片预览 + 点击放大 lightbox。lightbox 行为对齐 MarkdownContent 里的
 *  ImgRenderer(ESC/点遮罩关闭),但样式独立,避免动 chat 那边。 */
function ImagePreview({ name, src, size }: { name: string; src: string; size: number }) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handler)
      document.body.style.overflow = prev
    }
  }, [expanded])

  return (
    <div className={styles.imagePreviewWrap}>
      <div className={styles.imagePreviewMeta}>
        <span className={styles.imagePreviewName}>{name}</span>
        <span className={styles.imagePreviewSize}>{formatSize(size)}</span>
        <span className={styles.imagePreviewHint}>点击图片放大</span>
      </div>
      <div className={styles.imagePreviewStage}>
        <img
          src={src}
          alt={name}
          className={styles.imagePreviewImg}
          loading="lazy"
          onClick={() => setExpanded(true)}
        />
      </div>
      {expanded && createPortal(
        <div
          className={styles.lightbox}
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label={name}
        >
          <img
            src={src}
            alt={name}
            className={styles.lightboxImg}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className={styles.lightboxClose}
            onClick={() => setExpanded(false)}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

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
function findFileByPath(files: ArtifactFile[], path: string): ArtifactFile | null {
  for (const f of files) {
    if (f.path === path) return f
    if (f.type === 'directory' && f.children) {
      const hit = findFileByPath(f.children, path)
      if (hit) return hit
    }
  }
  return null
}

function FileTreeNode({
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
  const [mode, setMode] = useState<'view' | 'diff'>('view')
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

  useEffect(() => {
    if (!treeDragging) return
    const onMove = (e: MouseEvent) => {
      const start = treeDragStartRef.current
      if (!start) return
      const next = Math.max(
        TREE_WIDTH_MIN,
        Math.min(TREE_WIDTH_MAX, start.w + (e.clientX - start.x)),
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
    // refs 加载失败不阻塞主流程,下拉退化为只剩 HEAD 选项
    artifactsApi.listRefs(groupId).then(setRefs).catch(() => setRefs(null))
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
        <h3 className={styles.artifactTitle}>{'\u{1F4E6}'} Artifacts</h3>
        <div className={styles.previewActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTreeCollapsed((v) => !v)}
            title={treeCollapsed ? '展开文件树' : '收起文件树(让位给预览)'}
          >
            {treeCollapsed ? '\u{25B6}' : '\u{25C0}'}
          </Button>
          <Button variant="ghost" size="sm" onClick={loadFiles}>
            刷新
          </Button>
        </div>
      </div>
      {root && (
        <div className={styles.pathBar}>
          <span className={styles.pathBarPath} title={selectedFile ? absolutePath : root}>
            {selectedFile ? absolutePath : root}
          </span>
          {selectedFile && (
            <div className={styles.pathBarActions}>
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

      {/* 左右分栏:左文件树(可拖拽宽度),右预览(flex:1)。两者各拿全高,
          避免纵向挤。窄面板下文件树可折叠成只显示图标。 */}
      <div className={styles.splitLayout}>
        <div
          className={`${styles.treePane} ${treeCollapsed ? styles.treePaneCollapsed : ''}`}
          style={treeCollapsed ? undefined : { width: `${treeWidth}px`, flex: `0 0 ${treeWidth}px` }}
        >
          {files.length > 0 && (
            <div className={styles.searchRow}>
              <input
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
                  <select
                    className={styles.diffBaseSelect}
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
                  </select>
                  <input
                    className={styles.diffBaseInput}
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
          <p>从左侧选择文件预览</p>
          <p className={styles.previewEmptyHint}>
            支持 .md 渲染、图片直接预览、Monaco 代码高亮、diff 对比
          </p>
        </div>
      )}
        </div>
      </div>

      <TerminalPane groupId={groupId} />
    </div>
  )
}
