// MarkdownContent 的展示型子组件:思考块 / 工具调用块 / 补丁块 / 询问块 / 图片灯箱。
// 每个组件只有本地 useState/useEffect(流式结束强制折叠),不读父状态。
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import styles from './MarkdownContent.module.css'
import { safeParse, type AskQuestion, type ToolCall } from './markdownBlocks'

// MarkdownContent 经常被放进一个 onClick 触发弹窗的气泡里(<details>/<summary>
// 默认会让 click 冒泡上去,导致展开思考/工具调用时也弹出 prompt 弹窗)。
// 这里在交互元素上拦掉冒泡,让外层只在「点空白」时才触发。
function stopBubble(e: ReactMouseEvent) {
  e.stopPropagation()
}

export function ThinkingBlock({
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

export function ToolCallBlock({
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

export function ToolCallGroupBlock({
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

export function PatchBlock({ content, streaming }: { content: string; streaming?: boolean }) {
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

export function AskBlock({
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
export function ImgRenderer({ src, alt }: { src?: string; alt?: string }) {
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
