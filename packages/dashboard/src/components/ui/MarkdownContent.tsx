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
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './MarkdownContent.module.css'
import { StreamingStatus } from './StreamingStatus'

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
  | { type: 'status-thinking'; content: string }

type Part =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-call'; command: string; result?: string; streaming?: boolean }
  | { type: 'tool-call-group'; calls: ToolCall[]; streaming?: boolean }
  | { type: 'tool-patch'; content: string }
  | { type: 'tool-ask'; question: string; answer?: string; streaming?: boolean }
  | { type: 'status-thinking'; content: string }

interface ToolCall {
  command: string
  result?: string
  streaming?: boolean
}

const TAGS: Array<{ open: string; close: string; type: RawPart['type'] }> = [
  { open: '[thinking]', close: '[/thinking]', type: 'thinking' },
  { open: '[tool:exec]', close: '[/tool:exec]', type: 'tool-exec' },
  { open: '[tool-result:exec]', close: '[/tool-result:exec]', type: 'tool-result-exec' },
  { open: '[tool:patch]', close: '[/tool:patch]', type: 'tool-patch' },
  { open: '[tool:ask]', close: '[/tool:ask]', type: 'tool-ask' },
  { open: '[tool-result:ask]', close: '[/tool-result:ask]', type: 'tool-result-ask' },
  { open: '[status:thinking]', close: '[/status:thinking]', type: 'status-thinking' },
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
  // Codex v2 can emit two `item/started` (commandExecution) events back-to-back
  // before either `item/completed` arrives — parallel tool calls run in flight
  // simultaneously. The previous version of this function broke its forward
  // scan on the first intervening `tool-exec`, so cmd1 ended up with no result,
  // cmd2 got paired with r1, and r2 was emitted as an orphan `(unknown)`. To
  // handle the parallel case, we now use FIFO pairing: each `tool-exec` claims
  // the first *unconsumed* `tool-result-exec` we see going forward, regardless
  // of how many other `tool-exec` parts are in between. Same logic for ask.
  const out: Part[] = []
  const consumedResults = new Set<number>()

  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i]
    if (cur.type === 'tool-exec') {
      let result: string | undefined
      let streaming = cur.unclosed
      let consumed = i
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j]
        if (next.type === 'tool-result-exec' && !consumedResults.has(j)) {
          result = next.content
          streaming = streaming || next.unclosed
          consumedResults.add(j)
          consumed = j
          break
        }
        // Parallel `tool-exec` chunks don't break the search — that's the bug
        // we're fixing. But a different tool kind (patch / ask) still ends the
        // pair, since results from a different tool don't belong here.
        if (next.type === 'tool-patch' || next.type === 'tool-ask') break
        if (next.type === 'text' && next.content.trim() !== '') break
      }
      out.push({ type: 'tool-call', command: cur.content, result, streaming })
      i = consumed
    } else if (cur.type === 'tool-result-exec') {
      if (!consumedResults.has(i)) {
        consumedResults.add(i)
        out.push({ type: 'tool-call', command: '(unknown)', result: cur.content, streaming: cur.unclosed })
      }
    } else if (cur.type === 'tool-ask') {
      let answer: string | undefined
      let streaming = cur.unclosed
      let consumed = i
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j]
        if (next.type === 'tool-result-ask' && !consumedResults.has(j)) {
          answer = next.content
          streaming = streaming || next.unclosed
          consumedResults.add(j)
          consumed = j
          break
        }
        if (next.type === 'tool-exec' || next.type === 'tool-patch') break
        if (next.type === 'text' && next.content.trim() !== '') break
      }
      out.push({ type: 'tool-ask', question: cur.content, answer, streaming })
      i = consumed
    } else if (cur.type === 'tool-result-ask') {
      if (!consumedResults.has(i)) {
        consumedResults.add(i)
        out.push({ type: 'tool-ask', question: '', answer: cur.content, streaming: cur.unclosed })
      }
    } else if (cur.type === 'tool-patch') {
      out.push({ type: 'tool-patch', content: cur.content })
    } else {
      out.push(cur)
    }
  }
  return out
}

// Collapse every status-thinking part down to the latest one. As the executor
// streams more content into a single message, the content string accumulates
// repeated `[status:thinking]…[/status:thinking]` tags (e.g. a "Working" tag
// at turn start, then a "**Reviewing the test**" extracted from reasoning,
// then a "Done" tag on tool completion). We want the pill to reflect the
// most recent value, mirroring codex's `set_status_header` overwriting
// behavior (codex-rs/tui/src/chatwidget/status_controls.rs:58-65).
function hoistStatus(parts: Part[]): { status: string | null; rest: Part[] } {
  let status: string | null = null
  const rest: Part[] = []
  for (const p of parts) {
    if (p.type === 'status-thinking') {
      status = p.content
    } else {
      rest.push(p)
    }
  }
  return { status, rest }
}

// Hermes 把 "Working" 状态标签放在每个 agent_message_chunk 之后,被
// parseStructuredBlocks 切成一堆相邻的 text part(本质就是被 [status:thinking]
// 打断的同一段正文)。hoistStatus 之后这些 text parts 之间的 status tag 已经被
// 抽走,需要把相邻的 text 合并回单一 part,否则每个 part 各自被 ReactMarkdown
// 包成 <p>,几行字会排成几十行"竖排版"——这正是用户反馈的格式问题。
// tool / ask / patch 等仍然作为独立 part 保留,不被合并。
function mergeAdjacentTextParts(parts: Part[]): Part[] {
  const out: Part[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (p.type === 'text' && last && last.type === 'text') {
      last.content += p.content
    } else {
      out.push(p)
    }
  }
  return out
}

// Fold runs of consecutive tool-call parts into a single tool-call-group,
// mirroring codex TUI's "Ran N commands" disclosure (instead of letting N
// stacked <details> blocks eat the whole viewport). Threshold is 2 — a
// single tool call is already the right shape as-is, and forcing it into a
// group would just add an extra level of disclosure for no win. Runs are
// broken by anything that isn't a tool-call (text / thinking / patch / ask).
//
// Whitespace-only text parts (e.g. the single `\n` that every executor
// emits after a [tool-result:exec] tag) do NOT break the run — that's the
// only way N consecutive tool calls ever stay consecutive in practice.
// Anything with non-whitespace content (agent narration between commands,
// an inline summary, etc.) DOES break the run and starts a new group.
//
// Only used DURING streaming. After streaming ends, hoistAllToolCallsToTop
// takes over to lift non-consecutive calls into a single top-of-message
// group, so the final message reads "all commands" → "narration" top-down
// instead of interleaving commands with the agent's prose.
function groupConsecutiveToolCalls(parts: Part[]): Part[] {
  const out: Part[] = []
  let buffer: ToolCall[] = []
  const flush = () => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      out.push({ type: 'tool-call', ...buffer[0] })
    } else {
      out.push({ type: 'tool-call-group', calls: buffer, streaming: buffer.some(c => c.streaming) })
    }
    buffer = []
  }
  for (const p of parts) {
    if (p.type === 'tool-call') {
      buffer.push({ command: p.command, result: p.result, streaming: p.streaming })
    } else if (p.type === 'text' && p.content.trim() === '') {
      // skip — don't flush, don't emit
    } else {
      flush()
      out.push(p)
    }
  }
  flush()
  return out
}

// Post-streaming transform: lift every tool-call (regardless of where it
// appeared in the source order) into a single group at the top, with
// everything else trailing in original order. Two reasons we don't run
// this during streaming:
//   1. Mid-stream re-aggregation would shift the layout under the user
//      each time a new tool call arrives, which is visually jarring.
//   2. During streaming, the natural source order (text → tool → text →
//      tool) carries a "the agent is doing X" signal that's useful for
//      live progress; the user can read the latest narration as it comes.
// Once the turn is done, that temporal signal is no longer load-bearing —
// the message is now a record of what happened, not what's happening — so
// the concise top-down layout wins. Single tool call stays as a plain
// tool-call (no group wrapper) to avoid an extra level of disclosure.
function hoistAllToolCallsToTop(parts: Part[]): Part[] {
  const calls: ToolCall[] = []
  const rest: Part[] = []
  for (const p of parts) {
    if (p.type === 'tool-call') {
      calls.push({ command: p.command, result: p.result, streaming: p.streaming })
    } else {
      rest.push(p)
    }
  }
  if (calls.length === 0) return parts
  const out: Part[] = []
  if (calls.length === 1) {
    out.push({ type: 'tool-call', ...calls[0] })
  } else {
    out.push({ type: 'tool-call-group', calls, streaming: calls.some(c => c.streaming) })
  }
  out.push(...rest)
  return out
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
    return {
      status,
      rest: streaming
        ? groupConsecutiveToolCalls(collapsed)
        : hoistAllToolCallsToTop(collapsed),
    }
  }, [content, streaming])
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

  if ((rest.length === 0 && !status) || (rest.length === 1 && rest[0].type === 'text' && !status)) {
    return (
      <div className={styles.md}>
        {status && !hideStatus && <StreamingStatus content={status} done={!streaming} />}
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mentionComponents}>
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
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={mentionComponents}>
                {part.content}
              </ReactMarkdown>
            )
          case 'thinking':
            return <ThinkingBlock key={i} content={part.content} streaming={streaming} />
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

function ThinkingBlock({ content, streaming }: { content: string; streaming?: boolean }) {
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
      <summary className={styles.thinkingSummary} onClick={stopBubble}>思考</summary>
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
