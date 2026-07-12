// 预览窗格:模式切换(渲染/源码)+ diff base 选择 + 内容渲染 switch
// (图片 / markdown / Monaco Editor / DiffEditor)。自包含 diff 子流程:
// viewMode/diffBase/refs/original/diffLoading + handleDiff 都在这里。
// 切文件时 [selectedFile] effect 重置 original + viewMode(复刻原 handleSelect 行为);
// 切群时 [groupId] effect 重拉 refs。从 ArtifactPanel/index.tsx 抽出。
import { useEffect, useMemo, useState } from 'react'
import Editor, { DiffEditor } from '@monaco-editor/react'
import { artifactsApi, type ArtifactRefs } from '../../../api/artifacts'
import type { ArtifactContent, ArtifactFile, ArtifactOriginal } from '../../../api/types'
import { Select } from '../../../components/ui/Select'
import { Input } from '../../../components/ui/Input'
import { Button } from '../../../components/ui/Button'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import { ImagePreview } from './ImagePreview'
import { formatSize, detectLanguage, isMarkdownPath, isImagePath, buildImageDataUrl } from './artifactFileUtils'
import styles from './ArtifactPanel.module.css'

interface ArtifactPreviewProps {
  groupId: string
  selectedFile: ArtifactFile | null
  content: ArtifactContent | null
  contentLoading: boolean
  mode: 'view' | 'diff' | 'branchDiff'
  setMode: (m: 'view' | 'diff' | 'branchDiff') => void
  monacoReady: boolean
}

export function ArtifactPreview({
  groupId,
  selectedFile,
  content,
  contentLoading,
  mode,
  setMode,
  monacoReady,
}: ArtifactPreviewProps) {
  const [original, setOriginal] = useState<ArtifactOriginal | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffBase, setDiffBase] = useState<string>('')
  const [refs, setRefs] = useState<ArtifactRefs | null>(null)
  // MD 文件默认渲染成 HTML,viewMode='source' 时回退到 Monaco markdown 高亮。
  // 切换非 MD 文件时自动重置回 preview(对 MD 无影响,对后续切回 MD 生效)。
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')

  // refs 加载失败不阻塞主流程,diff-base 下拉退化为只剩 HEAD 选项
  useEffect(() => {
    artifactsApi.listRefs(groupId).then(setRefs).catch(() => setRefs(null))
  }, [groupId])

  // 切文件时清掉上一文件的 diff 原始内容 + 重置 viewMode(复刻原 handleSelect)。
  useEffect(() => {
    setOriginal(null)
    setViewMode('preview')
  }, [selectedFile])

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
  )
}
