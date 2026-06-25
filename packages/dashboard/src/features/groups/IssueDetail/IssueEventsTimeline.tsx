import { useState, lazy, Suspense } from 'react'
import type { IssueEvent, TodoItem } from '../../../api/types'
import type { ComposedPrompt } from '../../../api/groups'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import { StreamingStatus } from '../../../components/ui/StreamingStatus'
import { ComposedPromptModal } from '../modals/ComposedPromptModal'
import shared from './_shared.module.css'
import styles from './IssueEventsTimeline.module.css'
const LazyApprovalCard = lazy(() => import('./ApprovalCard').then((m) => ({ default: m.ApprovalCard })))

// 提取 content 里最后一个 [status:thinking]...[/status:thinking] 标签的内容。
// 与 MessageRow.extractMessageStatus 同语义,issue 链路里 executor 也会喷这种
// tag,放在 bubbleMeta 行(agent 名 + 时间)inline 展示,对齐群聊 MessageRow。
function extractMessageStatus(content: string): string | null {
  let last: string | null = null
  const re = /\[status:thinking\]([\s\S]*?)\[\/status:thinking\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    last = m[1]
  }
  return last
}

interface IssueEventsTimelineProps {
  events: IssueEvent[]
  issueId: string
  inProgress: boolean
  onApprovalResolved: () => Promise<void> | void
}

type TimelineItem =
  | { kind: 'approval'; event: IssueEvent }
  | { kind: 'append'; event: IssueEvent }
  | { kind: 'truncation'; event: IssueEvent }
  | { kind: 'todos'; event: IssueEvent; todos: TodoItem[] }
  | { kind: 'progress'; agent: string; firstAt: string; content: string; events: IssueEvent[] }
  | { kind: 'single'; event: IssueEvent }

// 真人发起的事件类型 → 右对齐用户气泡。其他事件(progress/output/completed/...)
// 一律视为 agent 输出 → 左对齐。用 event_type 而非 agent_name 判断,避免在
// agent 自建自执(created_by === assigned_to)的 issue 上,agent 的 progress
// 被误判为真人消息而右对齐,导致真人追加指令被淹没在 agent 输出里。
const HUMAN_EVENT_TYPES = new Set(['appended', 'continued', 'comment'])

// codex 把 [tool:exec]/[tool-result:exec] 拆成多个 chunk(一个 chunk = 一个 progress 事件),
// 单事件渲染没法把命令和输出配对。这里按 agent 把连续的 progress 合并成一个块,
// 交给 MarkdownContent 解析标记。终态事件(completed/failed/cancelled)单独显示。
//
// 去重:worker 完成时会发 sendUpdate(completed, result.fullOutput),fullOutput 是
// 整轮累积输出,和前面流式 progress chunks 内容重叠。如果 completed/failed 事件
// 前面已有同 agent 的 progress bubble,把终态事件的 content 置空(只留系统 chip),
// 避免内容渲染两遍。没有 progress 兜底场景(executor 不流式、只在最后发 fullOutput)
// 保留 content 作为唯一来源。
function groupEvents(events: IssueEvent[]): TimelineItem[] {
  const out: TimelineItem[] = []
  let bucket: { agent: string; firstAt: string; parts: string[]; events: IssueEvent[] } | null = null

  const flush = () => {
    if (!bucket) return
    out.push({
      kind: 'progress',
      agent: bucket.agent,
      firstAt: bucket.firstAt,
      content: bucket.parts.join(''),
      events: bucket.events,
    })
    bucket = null
  }

  for (const ev of events) {
    if (ev.event_type === 'approval_request') {
      flush()
      out.push({ kind: 'approval', event: ev })
      continue
    }
    if (ev.event_type === 'appended') {
      flush()
      out.push({ kind: 'append', event: ev })
      continue
    }
    if (ev.event_type === 'progress_truncated') {
      flush()
      out.push({ kind: 'truncation', event: ev })
      continue
    }
    if (ev.event_type === 'todos') {
      // todos 事件单成一类,绝不并入 progress bucket —— 后者会走 MarkdownContent
      // 渲染气泡,todos 应该走轻量 system chip 风格,只展示统计摘要。
      flush()
      const todos = parseTodosMetadata(ev.metadata)
      if (todos) out.push({ kind: 'todos', event: ev, todos })
      continue
    }
    const mergeable = ev.event_type === 'progress' || ev.event_type === 'output'
    if (!mergeable) {
      flush()
      // completed/failed 终态事件:如果前一个 progress bucket 是同一个 agent,
      // 说明流式 chunks 已经把内容展示过了,这里 suppress content 只留系统 chip。
      const prev = out[out.length - 1]
      const suppressContent =
        (ev.event_type === 'completed' || ev.event_type === 'failed') &&
        !!prev && prev.kind === 'progress' && prev.agent === ev.agent_name
      out.push({
        kind: 'single',
        event: suppressContent ? { ...ev, content: '' } : ev,
      })
      continue
    }
    if (bucket && bucket.agent === ev.agent_name) {
      bucket.parts.push(ev.content || '')
      bucket.events.push(ev)
    } else {
      flush()
      bucket = {
        agent: ev.agent_name,
        firstAt: ev.created_at,
        parts: [ev.content || ''],
        events: [ev],
      }
    }
  }
  flush()
  return out
}

function parseComposedPrompt(metadataStr: string): ComposedPrompt | null {
  if (!metadataStr) return null
  try {
    const parsed = JSON.parse(metadataStr)
    if (parsed?.composed_prompt?.layers && parsed.composed_prompt?.final) {
      const cp = parsed.composed_prompt
      return {
        layers: cp.layers,
        final: cp.final,
        generated_at: cp.generatedAt ?? cp.generated_at ?? '',
        prompt_version: cp.promptVersion ?? cp.prompt_version ?? 'unknown',
      }
    }
  } catch { /* ignore */ }
  return null
}

/** 从 issue_event.metadata 字符串里解析 todos 数组。仅用于 event_type='todos'
 *  的事件;master 落库时 metadata 形如 { todos: [...], count: N }。
 *  返回 null 表示 metadata 损坏,调用方应跳过该事件不渲染。 */
function parseTodosMetadata(metadataStr: string): TodoItem[] | null {
  if (!metadataStr) return null
  try {
    const parsed = JSON.parse(metadataStr) as { todos?: unknown }
    if (!Array.isArray(parsed.todos)) return null
    const out: TodoItem[] = []
    for (const item of parsed.todos) {
      if (!item || typeof item !== 'object') continue
      const r = item as Record<string, unknown>
      const content = typeof r.content === "string" ? r.content : ""
      if (!content) continue
      const status: TodoItem['status'] =
        r.status === 'in_progress' ? 'in_progress' :
        r.status === 'completed' ? 'completed' :
        'pending'
      const activeForm = typeof r.activeForm === "string" && r.activeForm ? r.activeForm : undefined
      out.push({ content, status, ...(activeForm ? { activeForm } : {}) })
    }
    return out.length > 0 ? out : null
  } catch { return null }
}

function formatTime(raw: string): string {
  const iso = raw + (raw.includes('Z') || raw.includes('+') ? '' : 'Z')
  return new Date(iso).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function IssueEventsTimeline({ events, issueId, inProgress, onApprovalResolved }: IssueEventsTimelineProps) {
  const items = groupEvents(events)
  // 最后一条 progress/单内容气泡是否还在 streaming(用来给 StreamingStatus 传 done)。
  // inProgress 时最后一条 agent 气泡视为正在流式。
  const lastContentIdx = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'progress' || (it.kind === 'single' && it.event.content)) return i
    }
    return -1
  })()

  const [promptData, setPromptData] = useState<{ prompt: ComposedPrompt; label: string } | null>(null)

  return (
    <div className={styles.issueEvents}>
      {items.map((item, idx) => {
        if (item.kind === 'approval') {
          // 审批卡保持原结构(需要完整宽度展示按钮),不走气泡布局
          return (
            <div key={item.event.id} className={shared.issueEventItem}>
              <span className={shared.issueEventTime}>{formatTime(item.event.created_at)}</span>
              <div className={styles.progressBody}>
                <span className={shared.issueEventAgent}>{item.event.agent_name}</span>
                <Suspense fallback={<div className={styles.progressBody}>加载中...</div>}>
                  <LazyApprovalCard
                    event={item.event}
                    issueId={issueId}
                    onResolved={onApprovalResolved}
                  />
                </Suspense>
              </div>
            </div>
          )
        }

        if (item.kind === 'append') {
          // 真人追加指令:强制右对齐 + mint 高亮 + "追加指令" 标题,
          // 不依赖 agent_name 匹配 created_by(agent 自建自执场景下 created_by
          // 就是 agent 名,旧的 isUser 判断会把 agent 的 progress 也右对齐,
          // 把真人追加淹没掉)。
          const ev = item.event
          return (
            <div
              key={ev.id}
              className={`${styles.bubbleRow} ${styles.bubbleRowUser}`}
            >
              <div className={`${styles.bubble} ${styles.bubbleAppend}`}>
                <div className={styles.bubbleMeta}>
                  <span className={styles.bubbleAgent}>追加指令 · {ev.agent_name}</span>
                  <span className={styles.bubbleTime}>{formatTime(ev.created_at)}</span>
                </div>
                <div className={styles.bubbleContent}>
                  <MarkdownContent content={ev.content} hideStatus />
                </div>
              </div>
            </div>
          )
        }

        if (item.kind === 'truncation') {
          // progress 被截断的 marker(由后端 getIssueEvents 插入):渲染成
          // 居中 chip,告诉用户「这里省略了 N 条早期 worker 流式输出」。
          // 不破坏对话流的视觉节奏,但明确提示存在未展示内容。
          const ev = item.event
          const omitted = (() => {
            try { return (JSON.parse(ev.metadata || '{}') as { omitted?: number }).omitted ?? 0 } catch { return 0 }
          })()
          return (
            <div key={`trunc-${idx}`} className={styles.systemChip}>
              <span className={styles.systemChipTag}>…</span>
              <span className={styles.systemChipAgent}>
                已省略 {omitted} 条早期进展
              </span>
            </div>
          )
        }

        if (item.kind === 'todos') {
          // todos 变化事件:渲染成轻量 chip(与 systemChip 同款容器),展示
          // 三态摘要。完整列表常驻在 IssueDetailHeader 下方的 WorkerTodosPanel,
          // 这里只是时间线上的历史轨迹标记,让用户能看出"todos 在这一刻变更过"。
          // 内容相同的相邻事件已被 master 去重,前端无需再 dedupe。
          const ev = item.event
          const counts = item.todos.reduce(
            (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc },
            {} as Record<TodoItem['status'], number>,
          )
          return (
            <div key={ev.id} className={styles.systemChip}>
              <span className={styles.systemChipTag}>📋 todo</span>
              <span className={styles.systemChipAgent}>
                {counts.completed ?? 0} 完成 · {counts.in_progress ?? 0} 进行 · {counts.pending ?? 0} 待办
              </span>
              <span className={styles.bubbleTime}>{formatTime(ev.created_at)}</span>
            </div>
          )
        }

        if (item.kind === 'progress') {
          const trimmed = item.content.trim()
          if (!trimmed) return null
          const status = extractMessageStatus(item.content)
          const streaming = inProgress && idx === lastContentIdx
          return (
            <div
              key={`prog-${item.events[0].id}-${idx}`}
              className={`${styles.bubbleRow} ${styles.bubbleRowAgent}`}
            >
              <div className={styles.bubble}>
                <div className={styles.bubbleMeta}>
                  <span className={styles.bubbleAgent}>{item.agent}</span>
                  <span className={styles.bubbleTime}>{formatTime(item.firstAt)}</span>
                  {status && (
                    <StreamingStatus content={status} done={!streaming} variant="inline" />
                  )}
                  {/* 取最后事件的 metadata 看有无 composed_prompt */}
                  {(item.events.length > 0 && parseComposedPrompt(item.events[item.events.length - 1].metadata)) && (
                    <span
                      className={styles.promptButton}
                      onClick={() => {
                        const cp = parseComposedPrompt(item.events[item.events.length - 1].metadata)
                        if (cp) setPromptData({ prompt: cp, label: `${item.agent} @ ${formatTime(item.firstAt)}` })
                      }}
                      title="查看 prompt 组合"
                    >
                      🔍 prompt
                    </span>
                  )}
                </div>
                <div className={styles.bubbleContent}>
                  <MarkdownContent content={item.content} hideStatus />
                </div>
              </div>
            </div>
          )
        }

        const ev = item.event
        const user = HUMAN_EVENT_TYPES.has(ev.event_type)
        // 系统事件(assigned/started/completed/failed/cancelled/interrupted 等)
        // 没有显著发言人对比,渲染成居中 chip 而不是气泡,避免和对话气泡混淆。
        const isSystem = !ev.content
        if (isSystem) {
          const hasCp = parseComposedPrompt(ev.metadata)
          // chip 显示 event_type + agent_name(如 "assigned 西花-claude"),
          // 否则中断/取消/分配只看到事件名,看不到对象。agent_name 缺失时跳过。
          const showAgent = !!ev.agent_name && ev.agent_name !== 'system'
          return (
            <div key={ev.id} className={styles.systemChip}>
              <span className={styles.systemChipTag}>{ev.event_type}</span>
              {showAgent && (
                <span className={styles.systemChipAgent}>{ev.agent_name}</span>
              )}
              <span className={styles.bubbleTime}>{formatTime(ev.created_at)}</span>
              {hasCp && (
                <span
                  className={styles.promptButton}
                  onClick={() => setPromptData({
                    prompt: hasCp,
                    label: `${ev.agent_name} @ ${formatTime(ev.created_at)}`,
                  })}
                  title="查看 prompt 组合"
                >
                  🔍
                </span>
              )}
            </div>
          )
        }
        const status = extractMessageStatus(ev.content)
        const streaming = inProgress && idx === lastContentIdx
        return (
          <div
            key={ev.id}
            className={`${styles.bubbleRow} ${user ? styles.bubbleRowUser : styles.bubbleRowAgent}`}
          >
            <div className={styles.bubble}>
              <div className={styles.bubbleMeta}>
                <span className={styles.bubbleAgent}>{ev.agent_name}</span>
                <span className={styles.bubbleTime}>{formatTime(ev.created_at)}</span>
                {status && (
                  <StreamingStatus content={status} done={!streaming} variant="inline" />
                )}
                {parseComposedPrompt(ev.metadata) && (
                  <span
                    className={styles.promptButton}
                    onClick={() => {
                      const cp = parseComposedPrompt(ev.metadata)
                      if (cp) setPromptData({ prompt: cp, label: `${ev.agent_name} @ ${formatTime(ev.created_at)}` })
                    }}
                    title="查看 prompt 组合"
                  >
                    🔍 prompt
                  </span>
                )}
              </div>
              <div className={styles.bubbleContent}>
                <MarkdownContent content={ev.content} hideStatus />
              </div>
            </div>
          </div>
        )
      })}
      {inProgress && (
        <div className={`${styles.bubbleRow} ${styles.bubbleRowAgent}`}>
          <div className={styles.bubble}>
            <div className={styles.loadingDots}>
              <span className={styles.dot}></span>
              <span className={styles.dot}></span>
              <span className={styles.dot}></span>
            </div>
          </div>
        </div>
      )}
      <ComposedPromptModal
        open={promptData !== null}
        messageLabel={promptData?.label}
        composedPrompt={promptData?.prompt ?? { layers: [], final: '', generated_at: '', prompt_version: '' }}
        onClose={() => setPromptData(null)}
      />
    </div>
  )
}
