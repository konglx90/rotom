import { useState, useRef, useEffect } from 'react'
import type { Agent, Group } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { MarkdownContent } from '../../components/ui/MarkdownContent'
import { useReadOnly, READ_ONLY_TITLE } from '../../hooks/useReadOnly'
import type { ChatMessage } from './types'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import { MemberListModal } from './modals/MemberListModal'
import { WorkingDirModal } from './modals/WorkingDirModal'
import { ConnectionBar } from './ConnectionBar'
import { useMessageHistoryNav } from './useMessageHistoryNav'
import styles from './ChatArea.module.css'

function renderContentWithMentions(content: string, streaming?: boolean) {
  const mentionPattern = /(@[\w一-鿿][\w.一-鿿-]*)/g
  if (!mentionPattern.test(content)) {
    return <MarkdownContent content={content} streaming={streaming} />
  }
  const parts = content.split(/(@[\w一-鿿][\w.一-鿿-]*)/g)
  const textParts = parts.filter(p => !p.startsWith('@')).join('')
  return (
    <>
      <span className={styles.mention}>
        {parts.filter(p => p.startsWith('@')).join(' ')}
      </span>{' '}
      <MarkdownContent content={textParts} streaming={streaming} />
    </>
  )
}

interface GroupChatAreaProps {
  selectedGroup: Group
  agents: Agent[]
  myAgentName: string
  messages: ChatMessage[]
  connectionStatus: ConnectionStatus
  onSendMessage: (text: string) => void
  onShowConfig: () => void
  onAddMembers: () => void
  onDeleteGroup: () => void
  onReconnect: () => void
  onUpdateWorkingDir: (dir: string | null) => void
}

export function GroupChatArea({
  selectedGroup,
  agents,
  myAgentName,
  messages,
  connectionStatus,
  onSendMessage,
  onShowConfig,
  onAddMembers,
  onDeleteGroup,
  onReconnect,
  onUpdateWorkingDir,
}: GroupChatAreaProps) {
  const readOnly = useReadOnly()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [message, setMessage] = useState<string>('')
  const [showMentionDropdown, setShowMentionDropdown] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState(-1)
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [showMemberList, setShowMemberList] = useState(false)
  const [showWorkingDirModal, setShowWorkingDirModal] = useState(false)

  const groupMembers = selectedGroup.members?.map(m => m.agent_name) || []
  const filteredMentionAgents = agents.filter(a =>
    a.name !== myAgentName && groupMembers.includes(a.name) &&
    a.name.toLowerCase().includes(mentionFilter.toLowerCase())
  )

  useEffect(() => {
    setMentionSelectedIndex(0)
  }, [mentionFilter])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!message && inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
  }, [message])

  const handleInputChange = (value: string) => {
    setMessage(value)
    const cursorPos = inputRef.current?.selectionStart ?? value.length
    const textBeforeCursor = value.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([\w一-鿿]*)$/)
    if (atMatch) {
      setShowMentionDropdown(true)
      setMentionFilter(atMatch[1])
      setMentionStartIndex(textBeforeCursor.lastIndexOf('@'))
    } else {
      setShowMentionDropdown(false)
    }
  }

  const handleMentionSelect = (agentName: string) => {
    const before = message.slice(0, mentionStartIndex)
    const after = message.slice(inputRef.current?.selectionStart ?? message.length)
    setMessage(`${before}@${agentName} ${after}`)
    setShowMentionDropdown(false)
    setMentionSelectedIndex(0)
    inputRef.current?.focus()
  }

  const handleEditWorkingDir = () => {
    setShowWorkingDirModal(true)
  }

  const handleSubmitWorkingDir = (dir: string | null) => {
    setShowWorkingDirModal(false)
    onUpdateWorkingDir(dir)
  }

  const { handleKeyDown: handleHistoryNav } = useMessageHistoryNav({
    value: message,
    setValue: setMessage,
    textareaRef: inputRef,
    disabled: showMentionDropdown,
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
          <h3 className={styles.chatTitle}>{selectedGroup.name}</h3>
          <button
            type="button"
            onClick={handleEditWorkingDir}
            className={styles.workingDirChip}
            title="点击修改工作目录"
          >
            📁 {selectedGroup.working_dir || '(未设置)'}
          </button>
          <div className={styles.memberAvatars}>
            {(selectedGroup.members || []).slice(0, 3).map(m => {
              const agent = agents.find(a => a.name === m.agent_name)
              const isOnline = agent?.status === 'online'
              return (
                <div key={m.agent_name} className={`${styles.memberAvatar} ${isOnline ? styles.online : ''}`}>
                  <Avatar name={m.agent_name} size={28} />
                </div>
              )
            })}
            {(selectedGroup.members?.length || 0) > 3 && (
              <button
                type="button"
                onClick={() => setShowMemberList(true)}
                className={styles.memberAvatar}
                style={{ background: 'var(--color-slate)', width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-surface)', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', padding: 0 }}
                title="查看全部成员"
              >
                +{(selectedGroup.members?.length || 0) - 3}
              </button>
            )}
          </div>
        </div>
        <div className={styles.chatHeaderActions}>
          <Button variant="ghost" size="sm" onClick={onAddMembers}
            disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined}>+ 拉人</Button>
          <Button variant="ghost" size="sm" iconOnly onClick={onShowConfig}
            disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : '设置'}>⚙️</Button>
          <Button variant="danger" outline size="sm" onClick={onDeleteGroup}
            disabled={readOnly} title={readOnly ? READ_ONLY_TITLE : undefined}>删除</Button>
        </div>
      </div>


      <MemberListModal
        open={showMemberList}
        memberNames={groupMembers}
        agents={agents}
        onClose={() => setShowMemberList(false)}
      />

      <WorkingDirModal
        open={showWorkingDirModal}
        scope="group"
        scopeName={selectedGroup.name}
        currentDir={selectedGroup.working_dir}
        onClose={() => setShowWorkingDirModal(false)}
        onSubmit={handleSubmitWorkingDir}
      />

      <ConnectionBar connectionStatus={connectionStatus} myAgentName={myAgentName} onReconnect={onReconnect} />

      <div className={styles.messagesArea}>
        {messages.length === 0 ? (
          <div className={styles.emptyChat}>在群 {selectedGroup.name} 中开始对话吧</div>
        ) : messages.map(msg => {
          const isSystem = msg.from === 'system'
          return (
          <div key={msg.id} className={`${styles.messageRow} ${msg.isIncoming ? '' : styles.outgoing} ${isSystem ? styles.systemRow : ''}`}>
            <Avatar name={msg.isIncoming ? msg.from : myAgentName} size={36} className={styles.messageAvatar} />
            <div className={`${styles.messageBubble} ${msg.isIncoming ? styles.incoming : styles.outgoing} ${isSystem ? styles.systemBubble : ''}`}>
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
                </div>
              )}
              <div className={styles.messageContent}>
                {msg.isLoading ? (
                  <div className={styles.loadingDots}>
                    <span className={styles.dot}></span>
                    <span className={styles.dot}></span>
                    <span className={styles.dot}></span>
                  </div>
                ) : renderContentWithMentions(msg.content, msg.streaming)}
              </div>
              <div className={styles.messageTimestamp}>
                {msg.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                {selectedGroup.working_dir && (
                  <span className={styles.messageCwd} title={selectedGroup.working_dir}>
                    📁 {selectedGroup.working_dir}
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
              </div>
            </div>
          </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className={styles.inputArea}>
        <textarea ref={inputRef} rows={1} value={message}
          onChange={e => {
            handleInputChange(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
          }}
          onKeyDown={e => {
            if (showMentionDropdown && filteredMentionAgents.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionSelectedIndex(i => (i + 1) % filteredMentionAgents.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionSelectedIndex(i => (i - 1 + filteredMentionAgents.length) % filteredMentionAgents.length)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleMentionSelect(filteredMentionAgents[mentionSelectedIndex].name)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setShowMentionDropdown(false)
                return
              }
            }
            if (handleHistoryNav(e)) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
              e.currentTarget.style.height = 'auto';
            }
          }}
          placeholder={readOnly ? '预览模式下不可发送消息' : (connectionStatus === 'connected' ? '输入消息... (Shift+Enter 换行, @ 提及成员)' : '等待连接...')}
          disabled={readOnly || connectionStatus !== 'connected'}
          title={readOnly ? READ_ONLY_TITLE : undefined}
          className={styles.messageInput} />
        <button onClick={handleSend}
          disabled={readOnly || !message.trim() || connectionStatus !== 'connected'}
          title={readOnly ? READ_ONLY_TITLE : undefined}
          className={styles.sendBtn}>发送</button>

        {showMentionDropdown && filteredMentionAgents.length > 0 && (
          <div className={styles.mentionDropdown}>
            {filteredMentionAgents.map((agent, idx) => (
              <div key={agent.id}
                className={`${styles.mentionItem} ${idx === mentionSelectedIndex ? styles.mentionItemActive : ''}`}
                onMouseEnter={() => setMentionSelectedIndex(idx)}
                onClick={() => handleMentionSelect(agent.name)}
              >
                <div className={agent.status === 'online' ? styles.mentionOnlineDot : styles.mentionOfflineDot} />
                {agent.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
