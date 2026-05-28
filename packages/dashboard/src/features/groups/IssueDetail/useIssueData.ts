import { useCallback, useEffect, useState } from 'react'
import { issuesApi, type IssueMessage } from '../../../api/issues'
import type { Issue, IssueEvent } from '../../../api/types'

// useIssueData — owns the issue/events/messages tuple and the refetch trigger.
// Refetches on (issueId change) and on (refreshSignal bumped by Master push).
// No polling.
export function useIssueData(issueId: string, refreshSignal?: number) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [messages, setMessages] = useState<IssueMessage[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const data = await issuesApi.getById(issueId)
      setIssue(data)
      setEvents(data.events || [])
      if (data.type === 'collaboration') {
        try { setMessages(await issuesApi.getMessages(issueId)) } catch { /* ignore */ }
      } else {
        setMessages([])
      }
    } catch (err) {
      console.error('Failed to load issue:', err)
    } finally {
      setLoading(false)
    }
  }, [issueId])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === 0) return
    reload()
  }, [refreshSignal, reload])

  return { issue, events, messages, loading, reload }
}
