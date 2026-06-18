/**
 * PendingQueuePreview —— in_progress 期间用户已发送但 worker 还没消费的
 * 追加指令 chip 列表。对齐 codex CLI 的 PendingInputPreview(bottom_pane/
 * pending_input_preview.rs:23):让用户看到「我发的消息排队中,本轮结束后
 * 会被合并进下一轮 prompt」。
 *
 * 数据流:chip 在 ContinueInputBar 提交时 push,在以下情况清空:
 *   • issue 翻终态(completed/failed/cancelled)—— IssueDetail 监听 status
 *     变化时调 clearPending
 *   • 用户点中断按钮 —— 中断触发 worker abort + finally 消费队列,chip
 *     对应的消息已被 worker 吃掉,所以 IssueDetail 在 onInterrupted 回调里
 *     clearPending
 *   • 用户手动点 × —— removePending(idx) 删单条
 *
 * 不做的事:不跟踪 worker 何时真正消费队列(in_progress → in_progress 续跑
 * 无显式信号)。如果用户没点中断、issue 也没翻终态,chip 会一直留着——
 * 用户可以手动 × 删,语义上「我发过这条」也算正确。
 */
interface PendingQueuePreviewProps {
  items: string[]
  onRemove: (idx: number) => void
}

export function PendingQueuePreview({ items, onRemove }: PendingQueuePreviewProps) {
  if (items.length === 0) return null
  return (
    <div className="pendingQueuePreview">
      <span className="pendingQueueLabel">待处理 ({items.length}):</span>
      {items.map((text, idx) => (
        <span key={idx} className="pendingQueueChip" title={text}>
          <span className="pendingQueueChipText">{truncate(text, 40)}</span>
          <button
            type="button"
            className="pendingQueueChipRemove"
            onClick={() => onRemove(idx)}
            aria-label="移除该待处理消息"
          >
            ×
          </button>
        </span>
      ))}
      <style>{`
        .pendingQueuePreview {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          padding: 4px 0 6px;
          font-size: 11px;
          color: var(--color-slate, #666);
        }
        .pendingQueueLabel {
          font-weight: 600;
          flex-shrink: 0;
        }
        .pendingQueueChip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          max-width: 220px;
          padding: 2px 4px 2px 8px;
          background: rgba(99, 102, 241, 0.1);
          border: 1px solid rgba(99, 102, 241, 0.25);
          border-radius: 10px;
          color: #4f46e5;
          font-size: 11px;
        }
        .pendingQueueChipText {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pendingQueueChipRemove {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 14px;
          height: 14px;
          padding: 0;
          border: none;
          background: transparent;
          color: #6366f1;
          font-size: 13px;
          line-height: 1;
          cursor: pointer;
          border-radius: 50%;
        }
        .pendingQueueChipRemove:hover {
          background: rgba(99, 102, 241, 0.2);
        }
      `}</style>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
