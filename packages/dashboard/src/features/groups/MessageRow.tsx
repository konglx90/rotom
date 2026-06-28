import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Reply, Search, Square } from 'lucide-react'
import type { Agent } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { StreamingStatus } from '../../components/ui/StreamingStatus'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import type { ChatMessage } from './types'
import { extractMentions } from './types'
import styles from './ChatArea.module.css'

// 长度阈值:超过任一阈值的气泡默认折叠,「查看更多」展开。
// 阈值调高 —— 只对真正长的消息折叠,短的保持原样。agent 跑活的
// 短反馈 / 中间产物留在 chat 里一眼看完,重的长内容才让用户主动
// 展开(或者直接去 issue 详情页看完整内容)。
const COLLAPSE_CHAR_THRESHOLD = 2400
const COLLAPSE_LINE_THRESHOLD = 48

// 结构化块标记(thinking / tool:exec / tool-result 等)。系统消息折叠时
// 用这个正则把工具/思考块整体剔除,取剩余文字的首行作为摘要。
// 与 GroupChatArea.tsx:89 的 STRUCT_BLOCK_RE 保持同步,新增标签时两处一起改
// (源头是 MarkdownContent.tsx:122 的 TAGS 列表)。
const STRUCT_BLOCK_RE = /\[(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\][\s\S]*?(?:\[\/(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\]|$)/g

// 系统消息折叠态摘要:剔除工具/思考块后,取首行非空文字,截断到 120 字符。
// 返回 null 表示剔除后没有任何可读文字(纯工具执行日志),此时折叠态展示占位符。
function extractSystemSummary(content: string): { summary: string; hasMore: boolean } | null {
  const hadStructBlocks = (content.match(STRUCT_BLOCK_RE) ?? []).length > 0
  const stripped = content.replace(STRUCT_BLOCK_RE, '').replace(/\n{3,}/g, '\n').trim()
  if (!stripped) return null
  const firstLine = stripped.split('\n').find((l) => l.trim().length > 0) ?? ''
  const trimmed = firstLine.trim()
  if (!trimmed) return null
  // hasMore = 剔除后剩余文字不止一行,或原文含结构化块(工具/思考)被藏起来了
  const remainingLines = stripped.split('\n').filter((l) => l.trim().length > 0)
  const hasMore = remainingLines.length > 1 || hadStructBlocks
  const summary = trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed
  return { summary, hasMore }
}

interface MessageRowProps {
  msg: ChatMessage
  agents: Agent[]
  myAgentName: string
  groupMembers: readonly string[]
  onShowPrompt: (msg: ChatMessage) => void
  /** 引用消息到输入框。GroupChatArea 传入则显示 💬 按钮,DirectChatArea 不传则不显示。 */
  onQuote?: (msg: ChatMessage) => void
  /** 中断某个 agent 的在飞 chat 流。仅在 streaming && isIncoming 的气泡上渲染 ⏹ 按钮。 */
  onCancelStream?: (requestId: string, agentName: string) => void | Promise<void>
  /** 右键气泡时触发,父组件负责弹自定义菜单。isLoading 消息父组件应自行过滤。 */
  onContextMenu?: (e: React.MouseEvent, msg: ChatMessage) => void
  /** 连续消息(上一条来自同一 sender):隐藏头像和 sender 行,只显示 content。
   *  Slack/Discord 风格紧凑模式,避免同一人连发多条时重复显示头像和名字。 */
  isContinuation?: boolean
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
  onQuote,
  onCancelStream,
  onContextMenu,
  isContinuation,
}: MessageRowProps) {
  const isSystem = msg.from === 'system'
  const hasPrompt = Boolean(msg.composedPrompt)
  // @了我(当前登录用户):左侧棪色色条突显,让我在一堆 agent 气泡里一眼看到自己被点名
  const fromAgent = msg.isIncoming ? agents.find(a => a.name === msg.from) : undefined
  const mentionedNames = extractMentions(msg.content)
  const isMyMention =
    msg.isIncoming /* 只看别人发的;自己发的不算 */ &&
    mentionedNames.includes(myAgentName)
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

  // 长消息折叠逻辑。
  //  - 流式期间强制展开(用户需要看到 agent 实时写的每行)
  //  - 长度超过阈值且非流式时,默认折叠
  //  - 用户一旦点过「查看更多 / 收起」,记住状态直到消息 id 变化
  //    (新消息重新走默认折叠流程)
  // 估算长度按字符数 + 显式换行数双阈值,避免单行超长和多行短行两个
  // 极端情况都漏掉。loading dots 和纯空白不参与估算。
  const isLong = useMemo(() => {
    if (msg.isLoading) return false
    const trimmed = msg.content.trim()
    if (!trimmed) return false
    const lineCount = (msg.content.match(/\n/g) || []).length + 1
    return msg.content.length > COLLAPSE_CHAR_THRESHOLD || lineCount > COLLAPSE_LINE_THRESHOLD
  }, [msg.content, msg.isLoading])

  // 系统消息:默认折叠成一行摘要(剔除工具/思考块后的首行文字)。
  // 与长消息折叠共用 userExpanded 状态:默认收起,点「展开」看全文。
  // 纯工具日志(剔除后无文字)不进摘要逻辑,保持原样渲染避免空摘要。
  const systemSummary = useMemo(
    () => (isSystem && !msg.isLoading ? extractSystemSummary(msg.content) : null),
    [isSystem, msg.isLoading, msg.content],
  )
  const [userExpanded, setUserExpanded] = useState(false)
  useEffect(() => { setUserExpanded(false) }, [msg.id])
  const collapsed = isSystem
    ? (systemSummary?.hasMore && !userExpanded && !msg.streaming)
    : (isLong && !userExpanded && !msg.streaming)

  return (
    <div className={`${styles.messageRow} ${msg.isIncoming ? '' : styles.outgoing} ${isSystem ? styles.systemRow : ''} ${isMyMention ? styles.mentionMeRow : ''} ${isContinuation ? styles.continuation : ''}`}>
      {isContinuation ? (
        <div className={styles.avatarPlaceholder} aria-hidden="true" />
      ) : (
        <Avatar
                name={msg.isIncoming ? msg.from : myAgentName}
                src={agents.find(a => a.name === (msg.isIncoming ? msg.from : myAgentName))?.avatar_url}
                size={30}
                className={styles.messageAvatar} />
      )}
      <div
        className={`${styles.messageBubble} ${msg.isIncoming ? styles.incoming : styles.outgoing} ${isSystem ? styles.systemBubble : ''} ${isMyMention ? styles.mentionMeBubble : ''}`}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, msg) : undefined}
      >
        <div className={styles.messageSender}>
          <div className={styles.senderLeft}>
            {msg.isIncoming ? (
              <>
                <span className={styles.senderName}>{msg.from}</span>
                {isSystem ? (
                  <Badge tone="category" value="system">📣 系统</Badge>
                ) : (() => {
                  const cat = fromAgent?.profile?.category
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
              </>
            ) : (
              <span className={`${styles.senderName} ${styles.senderNameOutgoing}`}>{myAgentName}</span>
            )}
          </div>
          <div className={styles.senderMeta}>
            <span className={styles.senderActions}>
              {onQuote && (
                <button
                  type="button"
                  className={styles.messageActionBtn}
                  onClick={() => onQuote(msg)}
                  title="引用"
                  aria-label="引用"
                >
                  <Reply size={14} />
                </button>
              )}
              {hasPrompt && (
                <span
                  className={styles.messageActionBtn}
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
                  <Search size={14} />
                </span>
              )}
              {canCancel && (
                <button
                  type="button"
                  className={styles.stopBtn}
                  onClick={handleCancel}
                  title="中断当前响应"
                  aria-label="中断当前响应"
                >
                  <Square size={11} fill="currentColor" stroke="none" />
                </button>
              )}
            </span>
            <span className={styles.senderInfo}>
              {msg.isIncoming && msg.cwd && (
                <span className={styles.messageCwd} title={`Agent 实际工作目录：${msg.cwd}`}>
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
              <span className={styles.senderTime}>
                {msg.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              </span>
            </span>
          </div>
        </div>
        <div className={`${styles.messageContentWrapper} ${collapsed && !isSystem ? styles.collapsed : ''}`}>
          <div className={styles.messageContent}>
            {msg.isLoading ? (
              <div className={styles.loadingDots}>
                <span className={styles.dot}></span>
                <span className={styles.dot}></span>
                <span className={styles.dot}></span>
              </div>
            ) : isSystem && collapsed && systemSummary ? (
              <span className={styles.systemSummary} title={systemSummary.summary}>{systemSummary.summary}</span>
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
        </div>
        {((isLong && !isSystem) || (isSystem && systemSummary?.hasMore)) && !msg.streaming && !msg.isLoading && (
          <button
            type="button"
            className={styles.collapseToggle}
            onClick={() => setUserExpanded(v => !v)}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <>
                <ChevronDown size={12} />
                <span>展开</span>
              </>
            ) : (
              <>
                <ChevronUp size={12} />
                <span>收起</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
})
