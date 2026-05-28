export interface DiffData {
  tool: string
  hunks: Array<{ old_string: string; new_string: string }>
  new_content?: string
  truncated?: boolean
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', md: 'markdown', html: 'html', css: 'css', scss: 'scss',
  py: 'python', go: 'go', rs: 'rust', sh: 'shell', yaml: 'yaml', yml: 'yaml',
}

export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.module.css')) return 'css'
  const ext = lower.split('.').pop() || ''
  return LANG_BY_EXT[ext] || 'plaintext'
}

export const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  in_progress: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export const APPROVAL_STATUS_LABEL: Record<string, string> = {
  pending: '等待审批',
  accepted: '已通过',
  denied: '已拒绝',
  answered: '已答复',
}
