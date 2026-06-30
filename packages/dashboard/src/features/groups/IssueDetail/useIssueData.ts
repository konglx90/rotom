import { useCallback, useEffect, useState } from 'react'
import { issuesApi } from '../../../api/issues'
import type { Issue, IssueEvent } from '../../../api/types'

// useIssueData — owns the issue/events tuple and the refetch trigger.
// Refetches on (issueId change) and on (refreshSignal bumped by Master push).
// No polling.
export function useIssueData(issueId: string, refreshSignal?: number) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [events, setEvents] = useState<IssueEvent[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const data = await issuesApi.getById(issueId)
      setIssue(data)
      setEvents(data.events || [])
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

  return { issue, events, loading, reload }
}
