import { memo } from 'react'
import type { Agent } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { StreamingStatus } from '../../components/ui/StreamingStatus'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import type { ChatMessage } from './types'
import styles from './ChatArea.module.css'

interface MessageRowProps {
  msg: ChatMessage
  agents: Agent[]
  myAgentName: string
  groupMembers: readonly string[]
  onShowPrompt: (msg: ChatMessage) => void
  /** 中断某个 agent 的在飞 chat 流。仅在 streaming && isIncoming 的气泡上渲染 ⏹ 按钮。 */
  onCancelStream?: (requestId: string, agentName: string) => void | Promise<void>
  /** 右键气泡时触发,父组件负责弹自定义菜单。isLoading 消息父组件应自行过滤。 */
  onContextMenu?: (e: React.MouseEvent, msg: ChatMessage) => void
}

// Extract the last [status:thinking]...[/status:thinking] tag from message content.
function extractMessageStatus(content: string): string | null {
  let last: string | null = null;
  const re = /\[status:thinking\]([\s\S]*?)\[\/status:thinking\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    last = m[1];
  }
  return last;
}

// 单条消息独立成组件 + memo 包裹:流式 setState 触发 GroupChatArea 重渲染
// 时,messages.map() 仍会重建所有 React element,但 MessageRow.memo 在协调
// 阶段浅比较 props,引用未变的消息直接跳过整棵子树的 diff(包括外层 div /
// Avatar / Badge / MarkdownContent),配合 P0-3 稳定的 groupMembers,历史消
// 息在流式期间零开销。
export const MessageRow = memo(function MessageRow({
  msg,
  agents,
  myAgentName,
  groupMembers,
  onShowPrompt,
  onCancelStream,
  onContextMenu,
}: MessageRowProps) {
  const isSystem = msg.from === 'system'
  const hasPrompt = Boolean(msg.composedPrompt)
  // ⏹ 按钮条件:agent 正在流式响应中的 incoming 气泡。outgoing / 已完成的不显示。
  // 只在 bubble.id 是 stream_ 前缀(占位 id)时才渲染 —— 历史加载的 gm_/grp_/dm_
  // 前缀 id 不可能是 streaming 中的,跳过额外渲染开销。
  const canCancel = Boolean(
    msg.streaming && msg.isIncoming && msg.id.startsWith('stream_') && onCancelStream,
  )
  const handleCancel = () => {
    if (!onCancelStream) return
    const rid = msg.id.startsWith('stream_') ? msg.id.slice('stream_'.length) : msg.id
    onCancelStream(rid, msg.from)
  }

  return (
    <div className={`${styles.messageRow} ${msg.isIncoming ? '' : styles.outgoing} ${isSystem ? styles.systemRow : ''}`}>
      <Avatar name={msg.isIncoming ? msg.from : myAgentName} size={30} className={styles.messageAvatar} />
      <div
        className={`${styles.messageBubble} ${msg.isIncoming ? styles.incoming : styles.outgoing} ${isSystem ? styles.systemBubble : ''}`}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, msg) : undefined}
      >
        {msg.isIncoming && (
          <div className={styles.messageSender}>
            {msg.from}
            {isSystem ? (
              <Badge tone="category" value="system">📣 系统</Badge>
            ) : (() => {
              const agent = agents.find(a => a.name === msg.from)
              const cat = agent?.profile?.category
              if (!cat) return null
              return (
                <Badge tone="category" value={cat}>
                  {cat === '真人' ? '👤' : '🚀'} {cat}
                </Badge>
              )
            })()}
            {(() => {
              const st = extractMessageStatus(msg.content);
              if (!st) return null;
              return <StreamingStatus content={st} done={!msg.streaming} variant="inline" />;
            })()}
            {canCancel && (
              <button
                type="button"
                className={styles.stopBtn}
                onClick={handleCancel}
                title="中断当前响应"
                aria-label="中断当前响应"
              >
                ⏹ 中断
              </button>
            )}
          </div>
        )}
        <div className={styles.messageContent}>
          {msg.isLoading ? (
            <div className={styles.loadingDots}>
              <span className={styles.dot}></span>
              <span className={styles.dot}></span>
              <span className={styles.dot}></span>
            </div>
          ) : (
            <MarkdownContent
              content={msg.content}
              streaming={msg.streaming}
              mentionMembers={groupMembers}
              mentionClassName={styles.mention}
              hideStatus={true}
            />
          )}
        </div>
        {msg.cancelled && (
          <div className={styles.messageCancelledFooter}>
            <span className={styles.cancelledIcon}>⏹</span>
            <span>已中断 · {msg.cancelledAt?.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
          </div>
        )}
        <div className={styles.messageTimestamp}>
          {msg.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}
          {msg.isIncoming && msg.cwd && (
            <span
              className={styles.messageCwd}
              title={`Agent 实际工作目录：${msg.cwd}`}
            >
              📁 {msg.cwd}
            </span>
          )}
          {!msg.isIncoming && msg.status && (
            <span
              className={`${styles.messageStatus} ${styles[`status_${msg.status}`] || ''}`}
              title={msg.statusError || (
                msg.status === 'delivered' ? '已投送'
                : msg.status === 'queued' ? '对方离线,已暂存'
                : msg.status === 'failed' ? `投送失败${msg.statusError ? ': ' + msg.statusError : ''}`
                : '发送中'
              )}
            >
              {msg.status === 'delivered' ? '✓ 已投送'
                : msg.status === 'queued' ? '📭 已暂存'
                : msg.status === 'failed' ? '⚠ 失败'
                : '⏳ 发送中'}
            </span>
          )}
          {hasPrompt && (
            <span
              className={styles.messagePromptButton}
              role="button"
              tabIndex={0}
              onClick={() => onShowPrompt(msg)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onShowPrompt(msg)
                }
              }}
              title="查看 prompt 组合"
            >
              🔍 prompt
            </span>
          )}
        </div>
      </div>
    </div>
  )
})
