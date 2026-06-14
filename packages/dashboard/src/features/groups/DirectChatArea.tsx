import { useRef, useEffect, useState } from 'react'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import type { ChatMessage } from './types'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import { ConnectionBar } from './ConnectionBar'
import { useMessageHistoryNav } from './useMessageHistoryNav'
import { ComposedPromptModal } from './modals/ComposedPromptModal'
import styles from './ChatArea.module.css'

interface DirectChatAreaProps {
  directTarget: string
  myAgentName: string
  messages: ChatMessage[]
  connectionStatus: ConnectionStatus
  onSendMessage: (text: string) => void
  onNewDmConversation: () => void
  onShowConfig: () => void
  onReconnect: () => void
  /** Delete the current DM (the underlying `groups` row + its messages). */
  onDeleteConversation?: () => void
}

export function DirectChatArea({
  directTarget,
  myAgentName,
  messages,
  connectionStatus,
  onSendMessage,
  onNewDmConversation,
  onShowConfig,
  onReconnect,
  onDeleteConversation,
}: DirectChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState<string>('')
  const [composedPromptFor, setComposedPromptFor] = useState<ChatMessage | null>(null)
  // 防止 Enter 键 / 发送按钮被短时间多次触发:
  // 中文 IME 选词和 React keydown 会在同一 Enter 上连发;键盘连按 Enter
  // 也会触发重复提交。sendingRef 在提交后置 true,等下一帧再放开,确保
  // 一次"按下"只会真正发出一条消息。
  const sendingRef = useRef<boolean>(false)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!message && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [message])

  const { handleKeyDown: handleHistoryNav } = useMessageHistoryNav({
    value: message,
    setValue: setMessage,
    textareaRef: textareaRef,
  })

  const handleSend = () => {
    if (sendingRef.current) return
    const trimmed = message.trim()
    if (!trimmed || connectionStatus !== 'connected') return
    sendingRef.current = true
    onSendMessage(trimmed)
    setMessage('')
    // 用 microtask + setTimeout 兜底:macro task 里 React 已经把 message 状态清掉,
    // 但同一 Enter 触发的连续 keydown 还在同一 tick 内排队。下一帧再放开
    // 锁,既能过滤掉同一 Enter 的二次触发,又不影响用户连发不同消息。
    setTimeout(() => { sendingRef.current = false }, 250)
  }

  return (
    <>
      <div className={styles.chatHeader}>
        <div className={styles.chatHeaderLeft}>
          <Avatar name={directTarget} size={40} />
          <div style={{ overflow: 'hidden', minWidth: 0 }}>
            <h3 className={styles.chatTitle}>{directTarget}</h3>
            <div style={{ fontSize: 12, color: 'var(--color-success)' }}>在线</div>
          </div>
        </div>
        <div className={styles.chatHeaderActions}>
          <Button variant="ghost" size="sm" onClick={onNewDmConversation}>新对话</Button>
          {onDeleteConversation && (
            <Button variant="ghost" size="sm" onClick={onDeleteConversation} title="删除整个对话">
              删除
            </Button>
          )}
          <Button variant="ghost" size="sm" iconOnly onClick={onShowConfig} title="设置">⚙️</Button>
        </div>
      </div>

      <ConnectionBar connectionStatus={connectionStatus} myAgentName={myAgentName} onReconnect={onReconnect} />

      <div className={styles.messagesArea}>
        {messages.length === 0 ? (
          <div className={styles.emptyChat}>与 {directTarget} 开始一对一对话</div>
        ) : messages.map(msg => {
          const hasPrompt = Boolean(msg.composedPrompt)
          return (
          <div key={msg.id} className={`${styles.messageRow} ${msg.isIncoming ? '' : styles.outgoing}`}>
            <Avatar name={msg.isIncoming ? msg.from : myAgentName} size={36} className={styles.messageAvatar} />
            <div
              className={`${styles.messageBubble} ${msg.isIncoming ? styles.incoming : styles.outgoing}`}
            >
              {msg.isIncoming && <div className={styles.messageSender}>{msg.from}</div>}
              <div className={styles.messageContent}>
                {msg.isLoading ? (
                  <div className={styles.loadingDots}>
                    <span className={styles.dot}></span>
                    <span className={styles.dot}></span>
                    <span className={styles.dot}></span>
                  </div>
                ) : <MarkdownContent content={msg.content} streaming={msg.streaming} />}
              </div>
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
                {hasPrompt && (
                  <span
                    className={styles.messagePromptButton}
                    role="button"
                    tabIndex={0}
                    onClick={() => setComposedPromptFor(msg)}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setComposedPromptFor(msg)
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
        })}
        <div ref={messagesEndRef} />
      </div>

      <ComposedPromptModal
        open={composedPromptFor !== null}
        messageLabel={composedPromptFor ? `${composedPromptFor.from} @ ${composedPromptFor.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : undefined}
        composedPrompt={composedPromptFor?.composedPrompt ?? { layers: [], final: '', generated_at: '', prompt_version: '' }}
        onClose={() => setComposedPromptFor(null)}
      />

      <div className={styles.inputArea}>
        <textarea ref={textareaRef} rows={1} value={message}
          onChange={e => {
            setMessage(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
          }}
          onKeyDown={e => {
            if (handleHistoryNav(e)) return
            // 中文 / 日文 IME 选词阶段也走 keydown(Enter 用于 commit 选词),
            // 不能当成"提交消息"的 Enter。nativeEvent.isComposing 是浏览器的
            // 真实输入状态,比 React 的 e.isComposing 更可靠。
            if ((e.nativeEvent as KeyboardEvent).isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
              e.currentTarget.style.height = 'auto';
            }
          }}
          placeholder={connectionStatus === 'connected' ? `向 ${directTarget} 发送消息... (Shift+Enter 换行)` : '等待连接...'}
          disabled={connectionStatus !== 'connected'}
          className={styles.messageInput} />
        <button onClick={handleSend}
          disabled={!message.trim() || connectionStatus !== 'connected'}
          className={styles.sendBtn}>发送</button>
      </div>
    </>
  )
}
