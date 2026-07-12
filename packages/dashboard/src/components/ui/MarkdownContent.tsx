import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './MarkdownContent.module.css'
import { StreamingStatus } from './StreamingStatus'
import {
  MENTION_RE,
  REPLY_TAG_RE,
  parseStructuredBlocks,
  pairExecCalls,
  hoistStatus,
  mergeAdjacentTextParts,
  groupConsecutiveToolCalls,
  hoistAllToolCallsToTop,
  groupConsecutiveThinking,
  safeParse,
  type ToolCall,
  type AskQuestion,
} from './markdownBlocks'

interface Props {
  content: string
  streaming?: boolean
  /** When provided, @name occurrences whose name is in this list are highlighted inline. */
  mentionMembers?: readonly string[]
  /** Class applied to the wrapping <span> around a highlighted mention. */
  mentionClassName?: string
  /** When true, caller renders StreamingStatus externally on the sender line. */
  hideStatus?: boolean
}

// MarkdownContent 经常被放进一个 onClick 触发弹窗的气泡里(<details>/<summary>
// 默认会让 click 冒泡上去,导致展开思考/工具调用时也弹出 prompt 弹窗)。
// 这里在交互元素上拦掉冒泡,让外层只在「点空白」时才触发。
function stopBubble(e: ReactMouseEvent) {
  e.stopPropagation()
}

type MentionState = { firstDone: boolean }

// 同时识别 @mention 和 #reply 标记,在文本节点内做内联替换。
// - @mention:仅当 name 命中群成员时高亮(保留 firstDone 逻辑,只高亮首个)
// - #reply:无条件替换成 🧑‍💼 星期五 等待中 胶囊(每处都替换,因为 marker 是系统级语义)
// 两者共用一次扫描,避免对同一段文本走两遍正则。
function highlightInlineTokens(
  text: string,
  isMember: (name: string) => boolean,
  mentionClassName: string | undefined,
  replyClassName: string,
  keyPrefix: string,
  state: MentionState,
): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let matched = false
  let m: RegExpExecArray | null
  // 合并正则:要么 @name(捕获 1/2),要么 #reply(无捕获,整体匹配)
  const re = new RegExp(`(${MENTION_RE.source})|${REPLY_TAG_RE.source}`, 'g')
  while ((m = re.exec(text)) !== null) {
    let isMention = false
    let isReply = false
    let name = ''
    if (m[1] != null) {
      // @name 分支:m[2] 是去 @ 后的名字
      name = m[2]
      if (isMember(name)) isMention = true
    } else {
      isReply = true
    }
    if (!isMention && !isReply) continue
    matched = true
    if (m.index > last) out.push(text.slice(last, m.index))
    if (isMention) {
      if (!state.firstDone) {
        state.firstDone = true
        out.push(
          <span key={`${keyPrefix}-${m.index}`} className={mentionClassName}>
            @{name}
          </span>,
        )
      } else {
        out.push(`@${name}`)
      }
    } else {
      out.push(
        <span key={`${keyPrefix}-${m.index}`} className={replyClassName}>
          🧑‍💼 星期五 等待中
        </span>,
      )
    }
    last = m.index + m[0].length
  }
  if (!matched) return text
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

function transformMentionChildren(
  children: ReactNode,
  isMember: (name: string) => boolean,
  mentionClassName: string | undefined,
  replyClassName: string,
  keyPrefix = 'mention',
  state: MentionState = { firstDone: false },
): ReactNode {
  return Children.map(children, (child, idx) => {
    if (typeof child === 'string') {
      return highlightInlineTokens(child, isMember, mentionClassName, replyClassName, `${keyPrefix}-${idx}`, state)
    }
    if (!isValidElement(child)) return child
    const el = child as ReactElement<{ children?: ReactNode }>
    // Skip inline / block <code>: @ inside code is package paths, not mentions.
    if (el.type === 'code' || el.type === 'pre') return el
    if (el.props && el.props.children != null) {
      return cloneElement(el, {
        children: transformMentionChildren(
          el.props.children,
          isMember,
          mentionClassName,
          replyClassName,
          `${keyPrefix}-${idx}`,
          state,
        ),
      })
    }
    return el
  })
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  streaming,
  mentionMembers,
  mentionClassName,
  hideStatus,
}: Props) {
  // 这一坨 transform 链在每次 render 都会重跑(长消息 + 流式场景下尤其贵),
  // 用 content 锁住。streaming 现在也参与依赖:streaming 期间用相邻合并
  // (保持流式进度可读),结束后切到「全部工具调用提到最上」聚合(让消息在
  // 历史里更紧凑)。React.memo 也会帮我们屏蔽 content 没变时的 render。
  const { status, rest } = useMemo(() => {
    const parts = pairExecCalls(parseStructuredBlocks(content))
    const { status, rest: hoisted } = hoistStatus(parts)
    const collapsed = mergeAdjacentTextParts(hoisted)
    const arranged = streaming
      ? groupConsecutiveToolCalls(collapsed)
      : hoistAllToolCallsToTop(collapsed)
    return {
      status,
      rest: groupConsecutiveThinking(arranged),
    }
  }, [content, streaming])
  const mentionComponents = useMemo<Components | undefined>(() => {
    const hasMembers = !!mentionMembers && mentionMembers.length > 0
    // #reply 标记需要无条件渲染成胶囊,即使没有群成员列表也要启用 transformer。
    const hasReply = content.includes('#reply')
    const memberSet = new Set(mentionMembers ?? [])
    const isMember = (name: string) => memberSet.has(name)
    const replyClassName = styles.replyTag
    const wrap = (tag: keyof JSX.IntrinsicElements) =>
      function MentionWrapper({ children, node: _node, ...rest }: any) {
        return createElement(
          tag,
          rest,
          transformMentionChildren(children, isMember, mentionClassName, replyClassName),
        )
      }
    // 对话里的链接一律在新标签打开;若启用了 @mention/#reply 高亮,链接文本里的标记仍需转换。
    const link = function LinkRenderer({ children, node: _node, ...rest }: any) {
      return createElement(
        'a',
        { ...rest, target: '_blank', rel: 'noopener noreferrer' },
        hasMembers || hasReply
          ? transformMentionChildren(children, isMember, mentionClassName, replyClassName)
          : children,
      )
    }
    // 没有需要高亮的 @mention / #reply 时,只接管 <a>(新标签打开),其余元素沿用 react-markdown 默认渲染。
    if (!hasMembers && !hasReply) return { a: link } as Components
    // Cover text-containing markdown elements. <code>/<pre> are explicitly
    // skipped inside the transformer so package paths like `@types/react`
    // are not mis-highlighted.
    return {
      p: wrap('p'),
      li: wrap('li'),
      em: wrap('em'),
      strong: wrap('strong'),
      a: link,
      td: wrap('td'),
      th: wrap('th'),
      h1: wrap('h1'),
      h2: wrap('h2'),
      h3: wrap('h3'),
      h4: wrap('h4'),
      h5: wrap('h5'),
      h6: wrap('h6'),
      blockquote: wrap('blockquote'),
    } as Components
  }, [mentionMembers, mentionClassName, content])

  if ((rest.length === 0 && !status) || (rest.length === 1 && rest[0].type === 'text' && !status)) {
    return (
      <div className={styles.md}>
        {status && !hideStatus && <StreamingStatus content={status} done={!streaming} />}
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...mentionComponents, img: ImgRenderer }}>
          {content}
        </ReactMarkdown>
        {streaming && <span className={styles.cursor}>|</span>}
      </div>
    )
  }

  return (
    <div className={styles.md}>
      {status && !hideStatus && <StreamingStatus content={status} done={!streaming} />}
      {rest.map((part, i) => {
        switch (part.type) {
          case 'text':
            return (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={{ ...mentionComponents, img: ImgRenderer }}>
                {part.content}
              </ReactMarkdown>
            )
          case 'thinking':
            return <ThinkingBlock key={i} content={part.content} count={part.count} streaming={streaming} />
          case 'tool-call':
            return (
              <ToolCallBlock
                key={i}
                command={part.command}
                result={part.result}
                streaming={part.streaming}
              />
            )
          case 'tool-call-group':
            return (
              <ToolCallGroupBlock
                key={i}
                calls={part.calls}
                streaming={part.streaming}
              />
            )
          case 'tool-patch':
            return <PatchBlock key={i} content={part.content} streaming={streaming} />
          case 'tool-ask':
            return (
              <AskBlock
                key={i}
                question={part.question}
                answer={part.answer}
                streaming={part.streaming}
              />
            )
          case 'status-thinking':
            // Hoisted out by hoistStatus — never reaches here.
            return null
        }
      })}
      {streaming && <span className={styles.cursor}>|</span>}
    </div>
  )
})

function ThinkingBlock({
  content,
  count,
  streaming,
}: {
  content: string
  count?: number
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)
  // 流式结束后强制折叠,让用户回到"看汇总"的视角;用户后续主动展开仍生效。
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])
  return (
    <details
      className={styles.thinkingBlock}
      open={open}
      onClick={stopBubble}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.thinkingSummary} onClick={stopBubble}>
        思考{count && count > 1 ? <span className={styles.thinkingCount}>×{count}</span> : null}
      </summary>
      {open && <div className={styles.thinkingContent}>{content}</div>}
    </details>
  )
}

function ToolCallBlock({
  command,
  result,
  streaming,
}: {
  command: string
  result?: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)
  // 流式结束后强制折叠,匹配用户预期(在 streaming 期间可以点开看 result,
  // 完成后聊天历史保持整洁的折叠态)。用户可以再主动展开。
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])
  const resultLines = result ? result.split('\n').length : 0
  const hint = result
    ? ` ↳ ${resultLines} ${resultLines === 1 ? 'line' : 'lines'}`
    : streaming
      ? ' …'
      : ''
  return (
    <details
      className={styles.toolBlock}
      open={open}
      onClick={stopBubble}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.toolSummary} onClick={stopBubble}>
        <span className={styles.toolCommand}>{command.trim() || '(empty command)'}</span>
        {hint && <span className={styles.toolHint}>{hint}</span>}
      </summary>
      {open && (
        <div className={styles.toolContent}>
          <pre className={styles.toolCommandFull}>{command}</pre>
          {result !== undefined && (
            <pre className={styles.toolResult}>{result || '(no output)'}</pre>
          )}
        </div>
      )}
    </details>
  )
}

function ToolCallGroupBlock({
  calls,
  streaming,
}: {
  calls: ToolCall[]
  streaming?: boolean
}) {
  // Two-level disclosure: the group is collapsed by default (just shows the
  // summary with a command-name preview); once expanded, each row is itself
  // a click target that toggles just that command's result. This keeps the
  // chat history clean — you only see the verbose output for the commands
  // you actually care about — while still letting you expand individual
  // rows to compare results side by side.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])
  const totalLines = calls.reduce(
    (sum, c) => sum + (c.result ? c.result.split('\n').length : 0),
    0,
  )
  const hasStreaming = calls.some(c => c.streaming)
  const hint = hasStreaming
    ? ' …'
    : totalLines > 0
      ? ` ↳ output (${totalLines} ${totalLines === 1 ? 'line' : 'lines'} total)`
      : ''
  // Preview the first few command names in the summary so users can tell at a
  // glance what's inside without expanding. Long commands are truncated to
  // keep the summary line single-row; full text remains accessible on expand.
  const PREVIEW_COUNT = 2
  const PREVIEW_MAX_LEN = 40
  const truncate = (cmd: string) => {
    const trimmed = cmd.trim() || '(empty)'
    return trimmed.length > PREVIEW_MAX_LEN
      ? trimmed.slice(0, PREVIEW_MAX_LEN - 1) + '…'
      : trimmed
  }
  const preview = calls.slice(0, PREVIEW_COUNT).map(c => truncate(c.command)).join(', ')
  const more = calls.length > PREVIEW_COUNT ? ` +${calls.length - PREVIEW_COUNT} more` : ''
  return (
    <details
      className={styles.toolBlock}
      open={open}
      onClick={stopBubble}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.toolSummary} onClick={stopBubble}>
        <span className={styles.toolCommand}>Ran {calls.length} commands: {preview}{more}</span>
        {hint && <span className={styles.toolHint}>{hint}</span>}
      </summary>
      {open && (
        <div className={styles.toolContent}>
          {calls.map((call, idx) => (
            <GroupedCommandRow
              key={idx}
              call={call}
              isLast={idx === calls.length - 1}
            />
          ))}
        </div>
      )}
    </details>
  )
}

// A single command row inside an expanded group. Renders as a clickable row
// (when the command has a result) that toggles the result inline. The
// per-row expand state is intentionally NOT auto-reset on stream end — once
// the user has expanded a row to inspect an output, collapsing it on them
// when the turn completes would be more annoying than helpful.
function GroupedCommandRow({ call }: { call: ToolCall; isLast: boolean }) {
  const [showResult, setShowResult] = useState(false)
  const hasResult = call.result !== undefined
  const resultLines = call.result ? call.result.split('\n').length : 0
  const toggle = () => { if (hasResult) setShowResult(s => !s) }
  return (
    <div className={styles.groupedToolItem}>
      <div
        className={`${styles.groupedCommandRow} ${hasResult ? styles.expandable : ''} ${showResult ? styles.expanded : ''}`}
        onClick={hasResult ? (e => { e.stopPropagation(); toggle() }) : undefined}
        role={hasResult ? 'button' : undefined}
      >
        <span className={styles.groupedCommandText}>{call.command.trim() || '(empty command)'}</span>
        {hasResult && (
          <span className={styles.toolHint}>
            {showResult ? '▾' : '▸'} {resultLines} {resultLines === 1 ? 'line' : 'lines'}
          </span>
        )}
      </div>
      {showResult && hasResult && (
        <pre className={styles.groupedToolResult}>{call.result || '(no output)'}</pre>
      )}

    </div>
  )
}

function PatchBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  // 流式结束后强制折叠(diff body 很长,默认收起更易扫读)。
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])
  const lines = content.split('\n')
  // 从 unified diff `+++ /path` 头部行抓取文件名,在折叠态 summary 直接展示,
  // 不用展开就能看到改的是哪个文件。多文件 patch 取第一个,够覆盖 95% 场景。
  const headerLine = lines.find(l => l.startsWith('+++ '))
  const filePath = headerLine ? headerLine.slice(4).trim() : ''
  // 老 patch 标签只塞了文件路径单行,没有 +/- diff body,识别并兼容:
  // 把整条内容当成文件路径,不渲染 diff body。
  const legacyPathOnly = !filePath && lines.length === 1 && lines[0].trim().length > 0
  const displayPath = filePath || (legacyPathOnly ? lines[0].trim() : '')
  const stats = lines.reduce(
    (acc, line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) acc.add++
      else if (line.startsWith('-') && !line.startsWith('---')) acc.del++
      return acc
    },
    { add: 0, del: 0 },
  )

  return (
    <details
      className={styles.toolBlock}
      open={open}
      onClick={stopBubble}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.toolSummary} onClick={stopBubble}>
        <span className={styles.patchPill}>📝 apply patch</span>
        {displayPath && <span className={styles.toolCommand}>{displayPath}</span>}
        <span className={styles.toolHint}>
          {stats.add > 0 && <span className={styles.diffStatAdd}>+{stats.add}</span>}
          {stats.add > 0 && stats.del > 0 && ' '}
          {stats.del > 0 && <span className={styles.diffStatDel}>−{stats.del}</span>}
          {legacyPathOnly && <span className={styles.toolHint}> (旧记录无 diff 内容)</span>}
        </span>
      </summary>
      {open && !legacyPathOnly && (
        <div className={styles.toolContent}>
          <pre className={styles.diffPre}>
            {lines.map((line, idx) => {
              let cls = styles.diffLine
              if (line.startsWith('+++') || line.startsWith('---')) cls = `${styles.diffLine} ${styles.diffMeta}`
              else if (line.startsWith('@@')) cls = `${styles.diffLine} ${styles.diffHunk}`
              else if (line.startsWith('+')) cls = `${styles.diffLine} ${styles.diffAdd}`
              else if (line.startsWith('-')) cls = `${styles.diffLine} ${styles.diffDel}`
              else if (line.startsWith('***')) cls = `${styles.diffLine} ${styles.diffMeta}`
              return (
                <span key={idx} className={cls}>
                  {line || ' '}
                  {'\n'}
                </span>
              )
            })}
          </pre>
        </div>
      )}
    </details>
  )
}

function AskBlock({
  question,
  answer,
  streaming,
}: {
  question: string
  answer?: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)
  // 流式结束后强制折叠,跟 tool-call 保持一致;用户后续点击仍可展开。
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])
  const parsedQ = safeParse<{ questions?: AskQuestion[] }>(question)
  const questions = parsedQ?.questions ?? []
  const parsedA = answer ? safeParse<{ answers?: Record<string, string> }>(answer) : null
  const answers = parsedA?.answers ?? null

  const firstQ = questions[0]?.question ?? '询问用户'
  const more = questions.length > 1 ? ` (+${questions.length - 1})` : ''
  const hint = answers
    ? ` ↳ ${Object.keys(answers).length} 项已回答`
    : streaming
      ? ' …'
      : ' 等待回答'

  return (
    <details
      className={styles.toolBlock}
      open={open}
      onClick={stopBubble}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.toolSummary} onClick={stopBubble}>
        <span className={styles.askPill}>❓ ask</span>
        <span className={styles.toolCommand}>{firstQ}{more}</span>
        <span className={styles.toolHint}>{hint}</span>
      </summary>
      {open && (
        <div className={styles.toolContent}>
          {questions.length === 0 ? (
            <pre className={styles.toolResult}>{question || '(empty)'}</pre>
          ) : (
            <div className={styles.askBody}>
              {questions.map((q, qi) => {
                const userAnswer = answers && q.question ? answers[q.question] : undefined
                return (
                  <div key={qi} className={styles.askQuestion}>
                    <div className={styles.askQuestionTitle}>
                      {q.header && <span className={styles.askHeader}>{q.header}</span>}
                      <span>{q.question}</span>
                    </div>
                    {q.options && q.options.length > 0 && (
                      <ul className={styles.askOptions}>
                        {q.options.map((opt, oi) => {
                          const selected = userAnswer === opt.label
                          return (
                            <li
                              key={oi}
                              className={selected ? `${styles.askOption} ${styles.askOptionSelected}` : styles.askOption}
                            >
                              <span className={styles.askOptionLabel}>{opt.label}</span>
                              {opt.description && (
                                <span className={styles.askOptionDesc}>{opt.description}</span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    {userAnswer && !q.options?.some(o => o.label === userAnswer) && (
                      <div className={styles.askAnswerCustom}>
                        <span className={styles.askAnswerLabel}>回答：</span>
                        {userAnswer}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </details>
  )
}

// Inline image with click-to-expand lightbox. The CSS already gives `<img>`
// `cursor: zoom-in`, so we honor that affordance by opening a fullscreen
// overlay on click. ESC or backdrop click closes. Right-click copies the
// image's absolute URL to the clipboard (relative src resolved against
// window.location.origin, matching ImageGalleryTab's behavior).
function ImgRenderer({ src, alt }: { src?: string; alt?: string }) {
  // react-markdown v10 sometimes passes src as a string array; ignore that and
  // only honour the plain-string form (covers all real-world cases).
  const url = typeof src === 'string' ? src : undefined
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!expanded) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handler)
      document.body.style.overflow = prev
    }
  }, [expanded])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const handleContextMenu = (e: ReactMouseEvent) => {
    if (!url) return
    e.preventDefault()
    const absolute = /^https?:\/\//i.test(url) || url.startsWith('//')
      ? url
      : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
    navigator.clipboard?.writeText(absolute).then(
      () => setCopied(true),
      () => setCopied(true),
    )
  }

  return (
    <>
      <img
        src={url}
        alt={alt ?? ''}
        loading="lazy"
        onClick={() => url && setExpanded(true)}
        onContextMenu={handleContextMenu}
      />
      {copied && (
        <span className={styles.copyHint} role="status">已复制链接 ✓</span>
      )}
      {expanded && url && createPortal(
        <div
          className={styles.lightbox}
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label={alt ?? '图片预览'}
        >
          <img
            src={url}
            alt={alt ?? ''}
            className={styles.lightboxImg}
            onClick={e => e.stopPropagation()}
          />
          <button
            type="button"
            className={styles.lightboxClose}
            onClick={() => setExpanded(false)}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>,
        document.body,
      )}
    </>
  )
}
