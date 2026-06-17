import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { Agent, Group } from '../../api/types'
import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import type { ChatMessage } from './types'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import { MemberListModal } from './modals/MemberListModal'
import { ComposedPromptModal } from './modals/ComposedPromptModal'
import { MessageRow } from './MessageRow'
import { useMessageHistoryNav } from './useMessageHistoryNav'
import styles from './ChatArea.module.css'

// 默认只渲染最近 N 条消息,避免长会话下 DOM 节点数失控(参考
// docs/GROUP_CHAT_RENDER_PERF.md)。超过时在顶部提示并提供"查看全部"
// 按钮(一次性展开全部,可能短时间卡顿)。
const VISIBLE_LIMIT_DEFAULT = 300

interface GroupChatAreaProps {
  selectedGroup: Group
  agents: Agent[]
  myAgentName: string
  messages: ChatMessage[]
  connectionStatus: ConnectionStatus
  onSendMessage: (text: string) => void
  /** 中断某个 agent 的在飞 chat 流。透传给 MessageRow 的 ⏹ 按钮。 */
  onCancelStream?: (requestId: string, agentName: string) => void | Promise<void>
  onShowConfig: () => void
  onAddMembers: () => void
  onArchiveGroup: (archived: boolean) => void
  onUpdateMemberWorkingDir: (groupId: string, agentName: string, dir: string | null) => Promise<void> | void
}

export function GroupChatArea({
  selectedGroup,
  agents,
  myAgentName,
  messages,
  connectionStatus,
  onSendMessage,
  onCancelStream,
  onShowConfig,
  onAddMembers,
  onUpdateMemberWorkingDir,
}: GroupChatAreaProps) {
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [message, setMessage] = useState<string>('')
  const [showMentionDropdown, setShowMentionDropdown] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState(-1)
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [showMemberList, setShowMemberList] = useState(false)
  const [composedPromptFor, setComposedPromptFor] = useState<ChatMessage | null>(null)
  const handleShowPrompt = useCallback((msg: ChatMessage) => {
    setComposedPromptFor(msg)
  }, [])

  // 限制渲染的消息条数。visibleLimit = VISIBLE_LIMIT_DEFAULT 时只显示最近
  // 300 条;用户点击"查看全部"后展开成全部。切换群组时不重置(组件不卸载),
  // 但 visibleMessages 会按新 messages 数组重新派生。
  const [visibleLimit, setVisibleLimit] = useState(VISIBLE_LIMIT_DEFAULT)
  const visibleMessages = useMemo(() => {
    if (messages.length <= visibleLimit) return messages
    return messages.slice(messages.length - visibleLimit)
  }, [messages, visibleLimit])
  const hiddenCount = messages.length - visibleMessages.length
  // 用户点击"查看全部"时,跳过下一次自动滚动到底部,避免视口从中间历史
  // 消息被强制拉到最新一条。
  const skipNextAutoScrollRef = useRef(false)

  const groupMembers = useMemo(
    () => selectedGroup.members?.map(m => m.agent_name) || [],
    [selectedGroup.members],
  )
  const filteredMentionAgents = agents.filter(a =>
    a.name !== myAgentName && groupMembers.includes(a.name) &&
    a.name.toLowerCase().includes(mentionFilter.toLowerCase())
  )

  useEffect(() => {
    setMentionSelectedIndex(0)
  }, [mentionFilter])

  // 滚动到底部用 RAF 节流,避免流式高频更新下每次 messages 变都
  // 触发 layout/paint。用 scrollTop = scrollHeight 比 scrollIntoView 更
  // 可控(0 高度锚点 + scrollIntoView 在不同浏览器行为不稳)。每次
  // messages 变化都 cancel 旧的 RAF 重 schedule,确保最新一次状态变更
  // 一定触发滚动(否则发消息时若上一次 RAF 还在 pending,本次会被吞掉)。
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false
      return
    }
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const el = messagesAreaRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [visibleMessages])
  useEffect(() => () => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  const handleShowAllMessages = useCallback(() => {
    skipNextAutoScrollRef.current = true
    setVisibleLimit(messages.length)
  }, [messages.length])

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

  const isArchived = Boolean(selectedGroup.archived_at)

  return (
    <>
      {isArchived && (
        <div className={styles.archivedBanner}>
          🗄️ 该群已归档，只读模式
        </div>
      )}
      <div className={`${styles.chatHeader} ${headerCollapsed ? styles.chatHeaderCollapsed : ''}`}>
        <div className={styles.chatHeaderBar} onClick={() => setHeaderCollapsed(v => !v)}>
          <div className={styles.chatHeaderLeft}>
            <h3 className={styles.chatTitle}>{selectedGroup.name}</h3>
            {!headerCollapsed && (
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
                    onClick={(e) => { e.stopPropagation(); setShowMemberList(true) }}
                    className={styles.memberAvatar}
                    style={{ background: 'var(--color-slate)', width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-surface)', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer', padding: 0 }}
                    title="查看全部成员"
                  >
                    +{(selectedGroup.members?.length || 0) - 3}
                  </button>
                )}
              </div>
            )}
          </div>
          {!headerCollapsed && (
            <div className={styles.chatHeaderActions}>
              <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onAddMembers() }}>+ 拉人</Button>
              <Button variant="ghost" size="sm" iconOnly onClick={(e) => { e.stopPropagation(); onShowConfig() }} title="设置">⚙️</Button>
            </div>
          )}
          <div className={styles.chatHeaderSub}>
            <span className={`${styles.connectionDot} ${styles[connectionStatus]}`} />
            <span className={styles.connectionText}>
              {connectionStatus === 'connected' ? '已连接' :
               connectionStatus === 'connecting' ? '连接中...' :
               connectionStatus === 'conflict' ? '连接冲突' :
               '未连接'}
            </span>
            <span className={styles.connectionSep}>·</span>
            <span className={styles.connectionIdentity}>{myAgentName}</span>
            <button
              type="button"
              className={styles.headerCollapseBtn}
              onClick={(e) => { e.stopPropagation(); setHeaderCollapsed(v => !v) }}
              title={headerCollapsed ? '展开头部' : '收起头部'}
            >
              {headerCollapsed ? '▶' : '▼'}
            </button>
          </div>
        </div>
      </div>

      <MemberListModal
        open={showMemberList}
        members={selectedGroup.members || []}
        agents={agents}
        groupId={selectedGroup.id}
        groupWorkingDir={selectedGroup.working_dir ?? null}
        onClose={() => setShowMemberList(false)}
        onUpdateMemberWorkingDir={onUpdateMemberWorkingDir}
      />


      <ComposedPromptModal
        open={composedPromptFor !== null}
        messageLabel={composedPromptFor ? `${composedPromptFor.from} @ ${composedPromptFor.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : undefined}
        composedPrompt={composedPromptFor?.composedPrompt ?? { layers: [], final: '', generated_at: '', prompt_version: '' }}
        onClose={() => setComposedPromptFor(null)}
      />

      {hiddenCount > 0 && (
        <div className={styles.messagesTruncatedBanner}>
          <span>
            已折叠 {hiddenCount} 条较早消息,仅显示最近 {visibleMessages.length} 条(共 {messages.length} 条)
          </span>
          <button
            type="button"
            className={styles.messagesTruncatedButton}
            onClick={handleShowAllMessages}
          >
            查看全部
          </button>
        </div>
      )}

      <div ref={messagesAreaRef} className={styles.messagesArea}>
        {messages.length === 0 ? (
          <div className={styles.emptyChat}>在群 {selectedGroup.name} 中开始对话吧</div>
        ) : visibleMessages.map(msg => (
          <MessageRow
            key={msg.id}
            msg={msg}
            agents={agents}
            myAgentName={myAgentName}
            groupMembers={groupMembers}
            onShowPrompt={handleShowPrompt}
            onCancelStream={onCancelStream}
          />
        ))}
      </div>

      <div className={styles.inputArea}>
        <textarea ref={inputRef} rows={1} value={message}
          onChange={e => {
            if (isArchived) return;
            handleInputChange(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
          }}
          onKeyDown={e => {
            if (isArchived) return;
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
          placeholder={connectionStatus === 'connected' && !selectedGroup.archived_at ? '输入消息... (Shift+Enter 换行, @ 提及成员)' : '等待连接...'}
          disabled={connectionStatus !== 'connected'}
          className={styles.messageInput} />
        <button onClick={handleSend}
          disabled={isArchived || !message.trim() || connectionStatus !== 'connected'}
          className={styles.sendBtn}>发送</button>
        {isArchived && (
          <div className={styles.archivedNotice}>
            🗄️ 已归档
          </div>
        )}

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
