// MarkdownContent 的「结构化块」解析与变换管线,以及 @mention/#reply 内联高亮用的正则。
// 纯函数 + 类型,无 React 依赖,从 MarkdownContent.tsx 抽出以便单独测试/复用。

export const MENTION_RE = /@([\w一-鿿][\w.一-鿿-]*)/g
// #reply 标记:agent 提问其他 agent 时在正文末尾加的 marker,系统据此建 5min
// 超时 bridge(见 ws-hub/conversation.ts autoCreateBridgeOnMention)。负向 lookbehind 排除 `##reply` / `abc#reply`
// 这类不应被识别为 marker 的写法;尾部 \b 排除 `#replies` / `#replyxxx`。
export const REPLY_TAG_RE = /(?<![\w#])#reply\b/g

export type RawPart =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-exec'; content: string; unclosed?: boolean }
  | { type: 'tool-result-exec'; content: string; unclosed?: boolean }
  | { type: 'tool-patch'; content: string }
  | { type: 'tool-ask'; content: string; unclosed?: boolean }
  | { type: 'tool-result-ask'; content: string; unclosed?: boolean }
  | { type: 'status-thinking'; content: string }

export type Part =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string; count?: number }
  | { type: 'tool-call'; command: string; result?: string; streaming?: boolean }
  | { type: 'tool-call-group'; calls: ToolCall[]; streaming?: boolean }
  | { type: 'tool-patch'; content: string }
  | { type: 'tool-ask'; question: string; answer?: string; streaming?: boolean }
  | { type: 'status-thinking'; content: string }

export interface ToolCall {
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

export function parseStructuredBlocks(text: string): RawPart[] {
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

export function pairExecCalls(raw: RawPart[]): Part[] {
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
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j]
        if (next.type === 'tool-result-exec' && !consumedResults.has(j)) {
          result = next.content
          streaming = streaming || next.unclosed
          consumedResults.add(j)
          break
        }
        // Parallel `tool-exec` chunks don't break the search — that's the bug
        // we're fixing. But a different tool kind (patch / ask) still ends the
        // pair, since results from a different tool don't belong here.
        if (next.type === 'tool-patch' || next.type === 'tool-ask') break
        if (next.type === 'text' && next.content.trim() !== '') break
      }
      out.push({ type: 'tool-call', command: cur.content, result, streaming })
      // 不要 i = consumed:那会跳过 exec→result 之间的 parallel tool-exec
      // chunks(Claude Code 并行读多个文件时 [tool:exec]A[/tool:exec][tool:exec]B[/tool:exec]
      // 后跟两个 result),被跳过的 exec 不进 out,其 result 变孤儿渲染成
      // 「已省略命令记录」。consumedResults Set 已经保证 result 不被重复配对,
      // 让 for-loop 正常 i++ 即可。
    } else if (cur.type === 'tool-result-exec') {
      if (!consumedResults.has(i)) {
        consumedResults.add(i)
        // 孤儿 result:配对的 [tool:exec] 不在这段内容里(典型原因是
        // progress 被截断、或流式过程中 exec chunk 还没到)。不再用
        // "(unknown)" 这种误导性标签,改成明确提示命令记录缺失,但
        // 仍然把输出挂出来让用户能看。
        out.push({ type: 'tool-call', command: '(已省略命令记录)', result: cur.content, streaming: cur.unclosed })
      }
    } else if (cur.type === 'tool-ask') {
      let answer: string | undefined
      let streaming = cur.unclosed
      for (let j = i + 1; j < raw.length; j++) {
        const next = raw[j]
        if (next.type === 'tool-result-ask' && !consumedResults.has(j)) {
          answer = next.content
          streaming = streaming || next.unclosed
          consumedResults.add(j)
          break
        }
        if (next.type === 'tool-exec' || next.type === 'tool-patch') break
        if (next.type === 'text' && next.content.trim() !== '') break
      }
      out.push({ type: 'tool-ask', question: cur.content, answer, streaming })
      // 同 tool-exec 分支:不要 i = consumed,否则 parallel ask 会被跳过。
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
export function hoistStatus(parts: Part[]): { status: string | null; rest: Part[] } {
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
export function mergeAdjacentTextParts(parts: Part[]): Part[] {
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
export function groupConsecutiveToolCalls(parts: Part[]): Part[] {
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
export function hoistAllToolCallsToTop(parts: Part[]): Part[] {
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

// 把连续出现的多个「思考」折叠块合并成一个,summary 显示「思考×N」,而不是
// 每个 thinking 各占一个 <details> 框。agent 一个 turn 里常常 think → tool →
// think → tool,流式结束后 hoistAllToolCallsToTop 把所有工具调用提到顶部,
// 留在底部的 N 段思考就紧挨着排成一列,把后面的正文挤到很下面看不清。这里把
// 这一批相邻的思考合成一个可展开块,展开后用空行分隔各段内容。单个思考仍维持
// 原样(显示「思考」,不画蛇添足加 ×1)。
//
// 必须排在 hoistAllToolCallsToTop / groupConsecutiveToolCalls 之后跑——因为
// 「相邻」是在工具调用各就各位之后才成立的(参见上面 hoist 的注释)。
//
// 与 groupConsecutiveToolCalls 同理:相邻 thinking 之间只夹着空白(执行器在
// 每个结构化标签后 emit 的单个 \n)的 text part 不算「被打断」,会被吞掉;
// 一旦夹着有实质内容的 text / tool / ask / patch,这批就断开。
export function groupConsecutiveThinking(parts: Part[]): Part[] {
  const out: Part[] = []
  let buffer: string[] = []
  const flush = () => {
    if (buffer.length === 0) return
    if (buffer.length === 1) {
      out.push({ type: 'thinking', content: buffer[0] })
    } else {
      out.push({ type: 'thinking', content: buffer.join('\n\n'), count: buffer.length })
    }
    buffer = []
  }
  for (const p of parts) {
    if (p.type === 'thinking') {
      buffer.push(p.content)
    } else if (p.type === 'text' && p.content.trim() === '' && buffer.length > 0) {
      // 仅吞掉「思考与思考之间」的空白分隔;其它位置的空白(如正文前)原样保留
    } else {
      flush()
      out.push(p)
    }
  }
  flush()
  return out
}

export interface AskQuestion {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: Array<{ label?: string; description?: string }>
}

export function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
