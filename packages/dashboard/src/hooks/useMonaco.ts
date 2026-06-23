import { useEffect, useState } from 'react'
import { ensureMonaco } from '../utils/monaco'

// Triggers monaco setup on mount. Returns `ready: false` while the chunk +
// workers + language contributions are loading — callers should not render
// <Editor>/<DiffEditor> until ready, otherwise @monaco-editor/react's
// loader would race and try to fetch from CDN.
export function useMonaco() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    ensureMonaco().then(
      () => {
        if (!cancelled) setReady(true)
      },
      (e) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return { ready, error }
}