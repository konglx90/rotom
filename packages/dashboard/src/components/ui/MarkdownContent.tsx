import {
  Children,
  cloneElement,
  createElement,
  isValidElement,
  memo,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react'
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
} from './markdownBlocks'
import {
  ThinkingBlock,
  ToolCallBlock,
  ToolCallGroupBlock,
  PatchBlock,
  AskBlock,
  ImgRenderer,
} from './markdownBlocks.tsx'

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
