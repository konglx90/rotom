/**
 * PendingQueuePreview —— in_progress 期间用户的本地草稿队列 chip 列表。
 * 对齐 codex CLI 的 PendingInputPreview(bottom_pane/pending_input_preview.rs:23):
 * 让用户看到「我发的消息排队中,稍后会被合并进下一轮 prompt」。
 *
 * chip 是纯本地草稿,ContinueInputBar 提交时 push,不发 /append。两条 flush
 * 路径都会把草稿真正发给 worker 触发 --resume 续跑:
 *   • 用户按 ESC / 点「■ 中断」—— IssueDetailBody.handleInterrupt 先逐条
 *     /append flush(chip + textarea 当前草稿),再 /interrupt,worker abort +
 *     finally 块(worker-issue.ts:217-256)消费 pendingAppends。flush 完成后
 *     handleInterrupt 自己清空 chip + 草稿。
 *   • 用户不按 ESC、worker 自然跑完 —— IssueDetail 的 status 监听 effect
 *     自动 /continue(completed/failed)或 /append(paused),合并 chip 为一次
 *     prompt,worker 用 session_id --resume 起新轮。对齐 codex "steers persist
 *     across rounds"。
 *   • cancelled —— 直接丢弃草稿。
 *   • 用户手动点 × —— removePending(idx) 删单条。
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
