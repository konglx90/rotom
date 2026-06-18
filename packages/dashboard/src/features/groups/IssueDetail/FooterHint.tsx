/**
 * FooterHint —— IssueDetail 底部输入栏上方的快捷键提示行。对齐 codex CLI
 * 的 footer.rs:172 FooterMode 状态机:根据 issue.status + pendingQueue
 * 长度显示不同的 hint,引导用户当前能做什么。
 *
 *   open + 已指派        → Cmd+Enter 开始任务
 *   in_progress(空闲)   → Esc 中断当前步骤 · Cmd+Enter 加入队列
 *   in_progress + 有队列 → Esc 立即处理队列 · N 条待处理
 *   completed/failed     → Cmd+Enter 继续执行
 *   cancelled / open 未指派 → 不渲染
 */
import type { Issue } from '../../../api/types'

interface FooterHintProps {
  status: Issue['status']
  assignedTo?: string | null
  pendingCount: number
}

export function FooterHint({ status, assignedTo, pendingCount }: FooterHintProps) {
  let hint: string | null = null
  if (status === 'open' && assignedTo) {
    hint = 'Enter 开始任务 · Shift+Enter 换行'
  } else if (status === 'in_progress') {
    if (pendingCount > 0) {
      hint = `Esc 立即处理队列 · ${pendingCount} 条待处理 · Enter 加入队列`
    } else {
      hint = 'Esc 中断当前步骤 · Enter 加入队列 · Shift+Enter 换行'
    }
  } else if (status === 'completed' || status === 'failed') {
    hint = 'Enter 继续执行(基于上次 session) · Shift+Enter 换行'
  }
  if (!hint) return null
  return (
    <div className="footerHint">
      <span className="footerHintText">{hint}</span>
      <style>{`
        .footerHint {
          padding: 4px 14px;
          border-top: 1px solid var(--border-color-light, #eee);
          background: var(--color-paper, #fafafa);
          font-size: 11px;
          color: var(--color-slate, #888);
          font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
          letter-spacing: 0.01em;
          flex-shrink: 0;
        }
        .footerHintText {
          opacity: 0.85;
        }
      `}</style>
    </div>
  )
}
