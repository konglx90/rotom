import type { IssueEvent } from '../../../api/types'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import shared from './_shared.module.css'
import styles from './IssueEventsTimeline.module.css'
import { ApprovalCard } from './ApprovalCard'

interface IssueEventsTimelineProps {
  events: IssueEvent[]
  issueId: string
  inProgress: boolean
  onApprovalResolved: () => Promise<void> | void
}

type TimelineItem =
  | { kind: 'approval'; event: IssueEvent }
  | { kind: 'progress'; agent: string; firstAt: string; content: string; events: IssueEvent[] }
  | { kind: 'single'; event: IssueEvent }

// codex 把 [tool:exec]/[tool-result:exec] 拆成多个 chunk(一个 chunk = 一个 progress 事件),
// 单事件渲染没法把命令和输出配对。这里按 agent 把连续的 progress 合并成一个块,
// 交给 MarkdownContent 解析标记。终态事件(completed/failed/cancelled)单独显示。
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
    const mergeable = ev.event_type === 'progress' || ev.event_type === 'output'
    if (!mergeable) {
      flush()
      out.push({ kind: 'single', event: ev })
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

  return (
    <div className={styles.issueEvents}>
      {items.map((item, idx) => {
        if (item.kind === 'approval') {
          return (
            <div key={item.event.id} className={shared.issueEventItem}>
              <span className={shared.issueEventTime}>{formatTime(item.event.created_at)}</span>
              <div className={styles.progressBody}>
                <span className={shared.issueEventAgent}>{item.event.agent_name}</span>
                <ApprovalCard
                  event={item.event}
                  issueId={issueId}
                  onResolved={onApprovalResolved}
                />
              </div>
            </div>
          )
        }

        if (item.kind === 'progress') {
          const trimmed = item.content.trim()
          if (!trimmed) return null
          return (
            <div key={`prog-${item.events[0].id}-${idx}`} className={shared.issueEventItem}>
              <span className={shared.issueEventTime}>{formatTime(item.firstAt)}</span>
              <div className={styles.progressBody}>
                <span className={shared.issueEventAgent}>{item.agent}</span>
                <div className={styles.progressContent}>
                  <MarkdownContent content={item.content} />
                </div>
              </div>
            </div>
          )
        }

        const ev = item.event
        return (
          <div key={ev.id} className={shared.issueEventItem}>
            <span className={shared.issueEventTime}>{formatTime(ev.created_at)}</span>
            <div className={styles.progressBody}>
              <span className={shared.issueEventAgent}>{ev.agent_name}</span>
              {ev.content ? (
                <div className={styles.progressContent}>
                  <MarkdownContent content={ev.content} />
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
      {inProgress && (
        <div className={shared.issueEventItem}>
          <span className={shared.issueEventTime}>...</span>
          <div className={styles.loadingDots}>
            <span className={styles.dot}></span>
            <span className={styles.dot}></span>
            <span className={styles.dot}></span>
          </div>
        </div>
      )}
    </div>
  )
}
