import { useState, useEffect, useCallback, useMemo } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { artifactsApi } from '../../api/artifacts'
import type { ArtifactFile, ArtifactContent, ArtifactOriginal } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { SessionPanel } from './SessionPanel'
import { TerminalPane } from './TerminalPane'
import styles from './ArtifactPanel.module.css'

interface ArtifactPanelProps {
  groupId: string
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

export function ArtifactPanel({ groupId }: ArtifactPanelProps) {
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

  const handleSelect = async (file: ArtifactFile) => {
    setSelectedFile(file)
    setContentLoading(true)
    setOriginal(null)
    setMode('view')
    try {
      const data = await artifactsApi.getContent(groupId, file.path)
      setContent(data)
    } catch (err) {
      console.error('Failed to load file content:', err)
      setContent(null)
    } finally {
      setContentLoading(false)
    }
  }

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
        <h3 className={styles.artifactTitle}>{'\u{1F4E6}'} Results</h3>
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
              {root || '~/.rotom/results/'}
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
