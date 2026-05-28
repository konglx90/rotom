import type { IssueMessage } from '../../../api/issues'
import { MarkdownContent } from '../../../components/ui/MarkdownContent'
import shared from './_shared.module.css'

interface CollaborationMessagesProps {
  messages: IssueMessage[]
  maxRounds?: number | null
}

export function CollaborationMessages({ messages, maxRounds }: CollaborationMessagesProps) {
  if (messages.length === 0) return null
  return (
    <div className={shared.artifactsSection}>
      <div className={shared.artifactsTitle}>
        协作发言 ({messages.length}){maxRounds ? ` · 共 ${maxRounds} 轮` : ''}
      </div>
      {messages.map(m => (
        <div key={m.id} className={shared.issueEventItem}>
          <span className={shared.issueEventTime}>第 {m.round} 轮</span>
          <div>
            <span className={shared.issueEventAgent}>{m.agentName}</span>
            <div className={shared.issueEventContent}>
              <MarkdownContent content={m.content} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
