import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  memo,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './MarkdownContent.module.css'

interface Props {
  content: string
  streaming?: boolean
  /** When provided, @name occurrences whose name is in this list are highlighted inline. */
  mentionMembers?: readonly string[]
  /** Class applied to the wrapping <span> around a highlighted mention. */
  mentionClassName?: string
}

const MENTION_RE = /@([\w一-鿿][\w.一-鿿-]*)/g

// MarkdownContent 经常被放进一个 onClick 触发弹窗的气泡里(<details>/<summary>
// 默认会让 click 冒泡上去,导致展开思考/工具调用时也弹出 prompt 弹窗)。
// 这里在交互元素上拦掉冒泡,让外层只在「点空白」时才触发。
function stopBubble(e: ReactMouseEvent) {
  e.stopPropagation()
}

function highlightMentionsInText(
  text: string,
  isMember: (name: string) => boolean,
  className: string | undefined,
  keyPrefix: string,
): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let matched = false
  let m: RegExpExecArray | null
  // Each call uses a fresh regex to avoid lastIndex state.
  const re = new RegExp(MENTION_RE.source, 'g')
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    if (!isMember(name)) continue
    matched = true
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span key={`${keyPrefix}-${m.index}`} className={className}>
        @{name}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (!matched) return text
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

function transformMentionChildren(
  children: ReactNode,
  isMember: (name: string) => boolean,
  className: string | undefined,
  keyPrefix = 'mention',
): ReactNode {
  return Children.map(children, (child, idx) => {
    if (typeof child === 'string') {
      return highlightMentionsInText(child, isMember, className, `${keyPrefix}-${idx}`)
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
          className,
          `${keyPrefix}-${idx}`,
        ),
      })
    }
    return el
  })
}

type RawPart =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-exec'; content: string; unclosed?: boolean }
  | { type: 'tool-result-exec'; content: string; unclosed?: boolean }
  | { type: 'tool-patch'; content: string }
  | { type: 'tool-ask'; content: string; unclosed?: boolean }
  | { type: 'tool-result-ask'; content: string; unclosed?: boolean }

type Part =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-call'; command: string; result?: string; streaming?: boolean }
  | { type: 'tool-patch'; content: string }
  | { type: 'tool-ask'; question: string; answer?: string; streaming?: boolean }

const TAGS: Array<{ open: string; close: string; type: RawPart['type'] }> = [
  { open: '[thinking]', close: '[/thinking]', type: 'thinking' },
  { open: '[tool:exec]', close: '[/tool:exec]', type: 'tool-exec' },
  { open: '[tool-result:exec]', close: '[/tool-result:exec]', type: 'tool-result-exec' },
  { open: '[tool:patch]', close: '[/tool:patch]', type: 'tool-patch' },
  { open: '[tool:ask]', close: '[/tool:ask]', type: 'tool-ask' },
  { open: '[tool-result:ask]', close: '[/tool-result:ask]', type: 'tool-result-ask' },
]

function parseStructuredBlocks(text: string): RawPart[] {
  const parts: RawPart[] = []
  let i = 0
  while (i < text.length) {
    let nextIdx = -1
    let nextTag: typeof TAGS[number] | null = null
    for (const tag of TAGS) {
      const idx = text.indexOf(tag.open, i)
      if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
        nextIdx = idx
        nextTag = tag
      }
    }
    if (nextIdx === -1 || !nextTag) {
      if (i < text.length) parts.push({ type: 'text', content: text.slice(i) })
      break
    }
    if (nextIdx > i) {
      parts.push({ type: 'text', content: text.slice(i, nextIdx) })
    }
    const contentStart = nextIdx + nextTag.open.length
    const closeIdx = text.indexOf(nextTag.close, contentStart)
    if (closeIdx === -1) {
      parts.push({ type: nextTag.type, content: text.slice(contentStart), unclosed: true })
      break
    }
    parts.push({ type: nextTag.type, content: text.slice(contentStart, closeIdx) })
    i = closeIdx + nextTag.close.length
  }
  return parts
}

function pairExecCalls(raw: RawPart[]): Part[] {
  const out: Part[] = []
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i]
    if (cur.type === 'tool-exec') {
      let result: string | undefined
      let consumed = i
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j]
        if (next.type === 'tool-result-exec') {
          result = next.content
          consumed = j
          break
        }
        if (next.type === 'tool-exec' || next.type === 'tool-patch' || next.type === 'tool-ask') break
        if (next.type === 'text' && next.content.trim() !== '') break
      }
      out.push({ type: 'tool-call', command: cur.content, result, streaming: cur.unclosed })
      i = consumed
    } else if (cur.type === 'tool-result-exec') {
      out.push({ type: 'tool-call', command: '(unknown)', result: cur.content, streaming: cur.unclosed })
    } else if (cur.type === 'tool-ask') {
      let answer: string | undefined
      let consumed = i
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j]
        if (next.type === 'tool-result-ask') {
          answer = next.content
          consumed = j
          break
        }
        if (next.type === 'tool-exec' || next.type === 'tool-patch' || next.type === 'tool-ask') break
        if (next.type === 'text' && next.content.trim() !== '') break
      }
      out.push({ type: 'tool-ask', question: cur.content, answer, streaming: cur.unclosed })
      i = consumed
    } else if (cur.type === 'tool-result-ask') {
      out.push({ type: 'tool-ask', question: '', answer: cur.content, streaming: cur.unclosed })
    } else if (cur.type === 'tool-patch') {
      out.push({ type: 'tool-patch', content: cur.content })
    } else {
      out.push(cur)
    }
  }
  return out
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  streaming,
  mentionMembers,
  mentionClassName,
}: Props) {
  const parts = pairExecCalls(parseStructuredBlocks(content))

  const mentionComponents = useMemo<Components | undefined>(() => {
    if (!mentionMembers || mentionMembers.length === 0) return undefined
    const memberSet = new Set(mentionMembers)
    const isMember = (name: string) => memberSet.has(name)
    const wrap = (tag: keyof JSX.IntrinsicElements) =>
      function MentionWrapper({ children, node: _node, ...rest }: any) {
        return createElement(
          tag,
          rest,
          transformMentionChildren(children, isMember, mentionClassName),
        )
      }
    // Cover text-containing markdown elements. <code>/<pre> are explicitly
    // skipped inside the transformer so package paths like `@types/react`
    // are not mis-highlighted.
    return {
      p: wrap('p'),
      li: wrap('li'),
      em: wrap('em'),
      strong: wrap('strong'),
      a: wrap('a'),
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
  }, [mentionMembers, mentionClassName])

  if (parts.length === 0 || (parts.length === 1 && parts[0].type === 'text')) {
    return (
      <div className={styles.md}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mentionComponents}>
          {content}
        </ReactMarkdown>
        {streaming && <span className={styles.cursor}>|</span>}
      </div>
    )
  }

  return (
    <div className={styles.md}>
      {parts.map((part, i) => {
        switch (part.type) {
          case 'text':
            return (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={mentionComponents}>
                {part.content}
              </ReactMarkdown>
            )
          case 'thinking':
            return <ThinkingBlock key={i} content={part.content} />
          case 'tool-call':
            return (
              <ToolCallBlock
                key={i}
                command={part.command}
                result={part.result}
                streaming={part.streaming}
              />
            )
          case 'tool-patch':
            return <PatchBlock key={i} content={part.content} />
          case 'tool-ask':
            return (
              <AskBlock
                key={i}
                question={part.question}
                answer={part.answer}
                streaming={part.streaming}
              />
            )
        }
      })}
      {streaming && <span className={styles.cursor}>|</span>}
    </div>
  )
})

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className={styles.thinkingBlock}
      open={open}
      onClick={stopBubble}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.thinkingSummary} onClick={stopBubble}>💭 思考</summary>
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
  const resultLines = result ? result.split('\n').length : 0
  const hint = result
    ? ` ↳ output (${resultLines} ${resultLines === 1 ? 'line' : 'lines'})`
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
        <span className={styles.toolPrompt}>$</span>
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

function PatchBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
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

interface AskQuestion {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: Array<{ label?: string; description?: string }>
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
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
