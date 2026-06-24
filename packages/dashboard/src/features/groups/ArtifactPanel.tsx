import { useState, useEffect, useCallback, useMemo } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { artifactsApi } from '../../api/artifacts'
import type { ArtifactFile, ArtifactContent, ArtifactOriginal } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { SessionPanel } from './SessionPanel'
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

/**
 * Bus for "expand all / collapse all" actions. Bumping `token` re-applies
 * `mode` even when its value hasn't changed (otherwise React's effect would
 * skip a second click on the same button). `mode: null` lets nodes use their
 * own depth-based default.
 */
type ExpandSignal = { token: number; mode: 'expand' | 'collapse' | null }

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

function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.module.css')) return 'css'
  const ext = lower.split('.').pop() || ''
  return LANG_BY_EXT[ext] || 'plaintext'
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
  expandSignal,
}: {
  file: ArtifactFile
  selectedPath: string | null
  onSelect: (file: ArtifactFile) => void
  depth: number
  expandSignal: ExpandSignal
}) {
  const isDir = file.type === 'directory'
  const [expanded, setExpanded] = useState(() => isDir && depth < DEFAULT_EXPAND_DEPTH)
  const isActive = file.path === selectedPath

  useEffect(() => {
    if (!isDir) return
    if (expandSignal.mode === 'expand') setExpanded(true)
    else if (expandSignal.mode === 'collapse') setExpanded(false)
  }, [expandSignal.token, expandSignal.mode, isDir])

  return (
    <li>
      <div
        className={`${styles.fileItem} ${isActive ? styles.active : ''}`}
        style={{ paddingLeft: 14 + depth * 18 }}
        onClick={() => {
          if (isDir) {
            setExpanded(!expanded)
          } else {
            onSelect(file)
          }
        }}
      >
        {isDir ? (
          <span className={styles.fileIcon}>{expanded ? '\u{1F4C2}' : '\u{1F4C1}'}</span>
        ) : (
          <span className={styles.fileIcon}>{getFileIcon(file.name)}</span>
        )}
        <span className={styles.fileName}>{file.name}</span>
        {!isDir && <span className={styles.fileSize}>{formatSize(file.size)}</span>}
      </div>
      {isDir && expanded && file.children && (
        <ul className={styles.dirChildren}>
          {file.children.map((child) => (
            <FileTreeNode
              key={child.path}
              file={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
              expandSignal={expandSignal}
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
  const [mode, setMode] = useState<'view' | 'diff'>('view')
  const [expandSignal, setExpandSignal] = useState<ExpandSignal>({ token: 0, mode: null })
  const [debugExpanded, setDebugExpanded] = useState(false)
  const [sessionCount, setSessionCount] = useState<number | null>(null)
  const { ready: monacoReady } = useMonaco()

  const loadFiles = useCallback(async () => {
    try {
      setLoading(true)
      const data = await artifactsApi.list(groupId)
      setRoot(data.root)
      setFiles(data.files ?? [])
      // Reset expand-all/collapse-all so freshly-mounted nodes fall back to
      // their depth-based default (top level open, deeper levels closed).
      setExpandSignal({ token: 0, mode: null })
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
  }, [groupId, loadFiles])

  const handleSelect = useCallback(async (file: ArtifactFile) => {
    setSelectedFile(file)
    setContentLoading(true)
    setOriginal(null)
    setMode('view')
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

  const previewBinary = content?.type === 'binary'

  return (
    <div className={styles.artifactPanel}>
      <div className={styles.artifactHeader}>
        <h3 className={styles.artifactTitle}>{'\u{1F4E6}'} Artifacts</h3>
        <div className={styles.previewActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpandSignal((s) => ({ token: s.token + 1, mode: 'expand' }))}
          >
            展开
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpandSignal((s) => ({ token: s.token + 1, mode: 'collapse' }))}
          >
            折叠
          </Button>
          <Button variant="ghost" size="sm" onClick={loadFiles}>
            刷新
          </Button>
        </div>
      </div>
      {root && (
        <div className={styles.rootHint} title={root}>
          {root}
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
      ) : (
        <ul className={styles.fileTree}>
          {files.map((file) => (
            <FileTreeNode
              key={file.path}
              file={file}
              selectedPath={selectedFile?.path ?? null}
              onSelect={handleSelect}
              depth={0}
              expandSignal={expandSignal}
            />
          ))}
        </ul>
      )}

      {selectedFile && (
        <div className={styles.previewSection}>
          <div className={styles.previewHeader}>
            <div className={styles.previewHeaderTop}>
              <span className={styles.previewFileName} title={selectedFile.path}>{selectedFile.path}</span>
              <Button variant="ghost" size="sm" onClick={() => { setSelectedFile(null); setContent(null); setOriginal(null); setMode('view') }}>
                关闭
              </Button>
            </div>
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
                  <input
                    className={styles.diffBaseInput}
                    value={diffBase}
                    onChange={e => setDiffBase(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleDiff() }}
                    placeholder="默认 HEAD，可填 commit / 分支"
                    title="对比基准 (git ref / commit / 分支)，回车发起对比"
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
          ) : previewBinary ? (
            <div className={styles.diffNote}>二进制文件 ({formatSize(content!.size)})，无法直接预览。</div>
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

      <div className={styles.debugSection}>
        <button
          className={styles.debugHeader}
          onClick={() => setDebugExpanded((v) => !v)}
          aria-expanded={debugExpanded}
        >
          <span className={styles.debugChevron}>{debugExpanded ? '▼' : '▶'}</span>
          <span className={styles.debugTitle}>{'\u{1F527}'} Debug</span>
          <span className={styles.debugBadge} title="当前群的 backend sessions">
            Sessions{sessionCount === null ? '' : ` (${sessionCount})`}
          </span>
        </button>
        {debugExpanded && (
          <div className={styles.debugBody}>
            <SessionPanel
              groupId={groupId}
              onChange={setSessionCount}
            />
          </div>
        )}
      </div>

      <TerminalPane groupId={groupId} />
    </div>
  )
}
