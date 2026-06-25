import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { Agent, Group } from '../../api/types'
import { useVisitorMode } from '../../context/VisitorContext'
import type { ChatMessage } from './types'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import { ComposedPromptModal } from './modals/ComposedPromptModal'
import { MessageRow } from './MessageRow'
import { MessageContextMenu } from './MessageContextMenu'
import { useMessageHistoryNav } from './useMessageHistoryNav'
import { useImageUpload } from './useImageUpload'
import styles from './ChatArea.module.css'

// 默认只渲染最近 N 条消息,避免长会话下 DOM 节点数失控(参考
// docs/GROUP_CHAT_RENDER_PERF.md)。超过时在顶部提示并提供"查看全部"
// 按钮(一次性展开全部,可能短时间卡顿)。
const VISIBLE_LIMIT_DEFAULT = 300

// 距底部小于该值视为"贴底",允许小幅滚动/渲染抖动仍触发自动滚动。
// 量级取一个普通气泡的高度,避免鼠标轻微抖动就脱离贴底状态。
const STICK_TO_BOTTOM_THRESHOLD = 120

interface GroupChatAreaProps {
  selectedGroup: Group
  agents: Agent[]
  myAgentName: string
  messages: ChatMessage[]
  connectionStatus: ConnectionStatus
  onSendMessage: (text: string) => void
  /** 中断某个 agent 的在飞 chat 流。透传给 MessageRow 的 ⏹ 按钮。 */
  onCancelStream?: (requestId: string, agentName: string) => void | Promise<void>
}

export function GroupChatArea({
  selectedGroup,
  agents,
  myAgentName,
  messages,
  connectionStatus,
  onSendMessage,
  onCancelStream,
}: GroupChatAreaProps) {
  const messagesAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 用户是否贴在底部。向上滚查看历史时为 false,流式新 token 不再抢焦点;
  // 用户主动发消息或回到底部时回到 true。ref 而非 state,避免每次滚动
  // 触发整棵子树协调。
  const isAtBottomRef = useRef(true)

  const [message, setMessage] = useState<string>('')
  const [showMentionDropdown, setShowMentionDropdown] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState(-1)
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [composedPromptFor, setComposedPromptFor] = useState<ChatMessage | null>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const dragCounterRef = useRef(0)
  const { upload, uploading: isUploading } = useImageUpload(selectedGroup.id)
  const { isVisitor } = useVisitorMode()
  const handleShowPrompt = useCallback((msg: ChatMessage) => {
    setComposedPromptFor(msg)
  }, [])

  // 右键气泡弹自定义菜单。null = 不显示。每次右键覆盖 state,旧菜单自然卸载。
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; msg: ChatMessage } | null>(null)
  const handleMessageContextMenu = useCallback((e: React.MouseEvent, msg: ChatMessage) => {
    // loading dots / streaming 占位消息没有可引用内容,跳过。
    if (msg.isLoading) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, msg })
  }, [])

  // 把消息构造成 markdown 引用块:首行带 sender+时间,后续每行加 `> ` 前缀。
  // 消息原文里已有的 `>` 引用会自然形成嵌套 blockquote。
  //
  // 引用消息本质是「回应对方说的话」,作为对话上下文回传给对方 agent。工具调用
  // ([tool:exec] / [tool-result:exec] / [tool:patch] / [tool:ask]) 和思考过程
  // ([thinking] / [status:thinking]) 是 agent 的内部操作日志和内心独白,不是它的
  // 「发言」,留在引用里有三个问题:
  //   1. 噪声 —— 接收方看到的是一堆 `[tool:exec]rm -rf ...[/tool:exec]` 这种内部
  //      标记,反而干扰;对方要的是「你之前说了什么」,不是「你之前做了什么」。
  //   2. 体积 —— 一条消息 90% 可能是工具输出,原样引用会把 textarea 撑满,真正要
  //      回应的文本被淹掉。
  //   3. 语义错位 —— 接收方 agent 看到 blockquote 里嵌着工具块标记,可能误以为这是
  //      新一轮要执行的工具指令,造成指令混淆。
  // 因此这里把 MarkdownContent 解析的全部结构化块标记整体剔除(同步
  // MarkdownContent.tsx 的 TAGS 列表,新增标签时两处一起改)。流式中未闭合的标签
  // 也兜底:正则末尾的 `(?:\[/tag\]|$)` 让它吃到字符串尾。
  const STRUCT_BLOCK_RE = /\[(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\][\s\S]*?(?:\[\/(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\]|$)/g
  const buildQuote = useCallback((msg: ChatMessage): string => {
    const time = msg.timestamp.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const header = `> **@${msg.from}** · ${time}`
    const stripped = (msg.content || '')
      .replace(STRUCT_BLOCK_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!stripped) return ''
    const body = stripped.split('\n').map(l => `> ${l}`).join('\n')
    return `${header}\n${body}`
  }, [])

  // 追加到输入框末尾,空输入时不带前导空行。然后用 rAF 等 React commit 完成,
  // 再 focus + 把光标移到末尾 + 重新测 textarea 高度(沿用现有 auto-resize)。
  // 若剔除工具/思考块后没有可引用内容,静默跳过(避免插入一段只有 header 的空引用)。
  const handleQuote = useCallback((msg: ChatMessage) => {
    const quote = buildQuote(msg)
    if (!quote) {
      setContextMenu(null)
      return
    }
    setMessage(prev => (prev.trim() ? `${prev}\n\n${quote}\n\n` : `${quote}\n\n`))
    setContextMenu(null)
    requestAnimationFrame(() => {
      const ta = inputRef.current
      if (!ta) return
      ta.focus()
      ta.selectionStart = ta.selectionEnd = ta.value.length
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
    })
  }, [buildQuote])

  const handleCopy = useCallback(async (msg: ChatMessage, plain: boolean) => {
    const text = plain
      ? msg.content.replace(/[*_`>~\-\[\]!]/g, '')
      : msg.content
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
    setContextMenu(null)
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
  //
  // 贴底判断:用户向上滚查看历史时 isAtBottomRef 为 false,流式新 token
  // 不再抢焦点。先 cancel pending RAF 防止上一帧已 schedule 的滚动把
  // 用户拉回;RAF 回调内再检查一次,避免 pending 期间用户刚好上滚。
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false
      return
    }
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    if (!isAtBottomRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (!isAtBottomRef.current) return
      const el = messagesAreaRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [visibleMessages])
  useEffect(() => () => {
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  // 监听用户主动滚动:更新 isAtBottomRef。不参与 render,纯副作用。
  const handleMessagesScroll = useCallback(() => {
    const el = messagesAreaRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    isAtBottomRef.current = distance < STICK_TO_BOTTOM_THRESHOLD
  }, [])

  // 切换群组时重置贴底状态:新会话首屏应该贴底,不能继承上一个会话中
  // 用户向上滚动的状态。
  useEffect(() => {
    isAtBottomRef.current = true
  }, [selectedGroup.id])

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
    // 用户主动发消息意味着想看回复,强制回到贴底状态,后续 token 自动滚动
    isAtBottomRef.current = true
  }

  // 上传一张图,把 ![name](url) 插到 textarea 当前光标处。多图串行避免 backend
  // 同时间写同一文件目录的元数据抖动;压缩在浏览器端,顺序更稳。
  const insertUpload = useCallback(async (file: File) => {
    const result = await upload(file)
    if (!result) return
    const md = `\n![${file.name.replace(/[!\[\]()]/g, '')}](${result.url})\n`
    setMessage(prev => {
      const ta = inputRef.current
      const idx = ta ? (ta.selectionStart ?? prev.length) : prev.length
      return `${prev.slice(0, idx)}${md}${prev.slice(idx)}`
    })
    requestAnimationFrame(() => {
      const ta = inputRef.current
      if (!ta) return
      ta.focus()
      const pos = (ta.value.length)
      ta.selectionStart = ta.selectionEnd = pos
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
    })
  }, [upload])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    // 串行:Canvas 压缩 + base64 编码都跑在主线程,并发会卡 UI
    Array.from(files).reduce(
      (p, file) => p.then(() => insertUpload(file)),
      Promise.resolve(),
    )
    // 清空 value 让同一文件能再次选中(否则 onChange 不会触发)
    e.target.value = ''
  }, [insertUpload])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) imageFiles.push(f)
      }
    }
    if (imageFiles.length === 0) return
    e.preventDefault()
    imageFiles.reduce(
      (p, file) => p.then(() => insertUpload(file)),
      Promise.resolve(),
    )
  }, [insertUpload])

  // dragenter/dragleave counter:dragenter fires once per element entered, so
  // dragging over a message row + the wrapping div would otherwise flip the
  // state false prematurely. Counter pattern is the canonical fix.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    dragCounterRef.current += 1
    setIsDragActive(true)
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragActive(false)
    }
  }, [])
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragActive(false)
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    files.reduce(
      (p, file) => p.then(() => insertUpload(file)),
      Promise.resolve(),
    )
  }, [insertUpload])

  const isArchived = Boolean(selectedGroup.archived_at)

  return (
    <>
      {isArchived && (
        <div className={styles.archivedBanner}>
          🗄️ 该群已归档，只读模式
        </div>
      )}

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

      <div
        ref={messagesAreaRef}
        className={styles.messagesArea}
        onScroll={handleMessagesScroll}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {messages.length === 0 ? (
          <div className={styles.emptyChat}>在群 {selectedGroup.name} 中开始对话吧</div>
        ) : visibleMessages.map((msg, idx) => {
          const prev = visibleMessages[idx - 1];
          const isContinuation = !!prev && !prev.truncated && !msg.truncated && prev.from === msg.from;
          return (
            msg.truncated ? (
              <div key={msg.id} className={styles.truncatedChip}>
                已省略 {msg.truncated.omitted} 条较早消息
              </div>
            ) : (
              <MessageRow
                key={msg.id}
                msg={msg}
                agents={agents}
                myAgentName={myAgentName}
                groupMembers={groupMembers}
                onShowPrompt={handleShowPrompt}
                onQuote={handleQuote}
                onCancelStream={onCancelStream}
                onContextMenu={handleMessageContextMenu}
                isContinuation={isContinuation}
              />
            )
          );
        })}
        {isDragActive && (
          <div className={styles.dropOverlay}>
            <div className={styles.dropHint}>松手即可上传图片到群聊</div>
          </div>
        )}
      </div>

      {!isVisitor && (
        <div className={styles.inputArea}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className={styles.fileInputHidden}
            onChange={handleFileInputChange}
            disabled={isArchived || isUploading || connectionStatus !== 'connected'}
          />
          <textarea ref={inputRef} rows={1} value={message}
          onChange={e => {
            if (isArchived) return;
            handleInputChange(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
          }}
          onPaste={handlePaste}
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
          placeholder={connectionStatus === 'connected' && !selectedGroup.archived_at ? '输入消息... (Shift+Enter 换行, @ 提及成员, 粘贴/拖入图片自动上传)' : '等待连接...'}
          disabled={connectionStatus !== 'connected'}
          className={styles.messageInput} />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isArchived || isUploading || connectionStatus !== 'connected'}
          className={styles.uploadBtn}
          title="上传图片"
          aria-label="上传图片"
        >{isUploading ? '…' : '📎'}</button>
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
      )}

      {contextMenu && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          msg={contextMenu.msg}
          onQuote={handleQuote}
          onCopy={handleCopy}
          onShowPrompt={handleShowPrompt}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}
