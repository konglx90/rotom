// ArtifactPanel 的文件类型/语言探测工具:后缀→语言、图片路径识别、base64→data URL。
// 纯函数,无 React 依赖,从 ArtifactPanel.tsx 抽出。
import type { ArtifactContent } from '../../api/types'

export function formatSize(bytes: number): string {
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

export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.module.css')) return 'css'
  const ext = lower.split('.').pop() || ''
  return LANG_BY_EXT[ext] || 'plaintext'
}

export function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_RE.test(filePath)
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_RE.test(filePath)
}

/** 把后端 base64 返回的图片内容解码成 data URL,失败时返回 null。SVG
 *  后端按文本返回(不在 binaryExts 里),这里也兜底支持。*/
export function buildImageDataUrl(filePath: string, content: ArtifactContent): string | null {
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
