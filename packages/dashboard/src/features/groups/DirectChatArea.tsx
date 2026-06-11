import { useRef, useEffect, useState } from 'react'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import type { ChatMessage } from './types'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import { ConnectionBar } from './ConnectionBar'
import { useMessageHistoryNav } from './useMessageHistoryNav'
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
}: DirectChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState<string>('')

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
    const trimmed = message.trim()
    if (!trimmed || connectionStatus !== 'connected') return
    onSendMessage(trimmed)
    setMessage('')
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
          <Button variant="ghost" size="sm" iconOnly onClick={onShowConfig} title="设置">⚙️</Button>
        </div>
      </div>

      <ConnectionBar connectionStatus={connectionStatus} myAgentName={myAgentName} onReconnect={onReconnect} />

      <div className={styles.messagesArea}>
        {messages.length === 0 ? (
          <div className={styles.emptyChat}>与 {directTarget} 开始一对一对话</div>
        ) : messages.map(msg => (
          <div key={msg.id} className={`${styles.messageRow} ${msg.isIncoming ? '' : styles.outgoing}`}>
            <Avatar name={msg.isIncoming ? msg.from : myAgentName} size={36} className={styles.messageAvatar} />
            <div className={`${styles.messageBubble} ${msg.isIncoming ? styles.incoming : styles.outgoing}`}>
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
              </div>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputArea}>
        <textarea ref={textareaRef} rows={1} value={message}
          onChange={e => {
            setMessage(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
          }}
          onKeyDown={e => {
            if (handleHistoryNav(e)) return
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
