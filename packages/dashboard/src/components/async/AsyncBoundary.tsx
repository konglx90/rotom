import type { ReactNode } from 'react'

interface AsyncBoundaryProps<T> {
  /** Async payload — usually `data` from a useQuery/useState. */
  data: T | null | undefined
  /** True while the request is in-flight. */
  loading: boolean
  /** Error returned by the request, or null/undefined if none. */
  error?: Error | string | null
  /** Predicate to decide whether `data` should be treated as "empty". */
  isEmpty?: (data: T) => boolean
  /** Invoked when the user clicks the "retry" button in the error fallback. */
  onRetry?: () => void
  /** Override the default loading spinner. */
  loadingFallback?: ReactNode
  /** Override the default error panel. */
  errorFallback?: (error: Error | string, retry: () => void) => ReactNode
  /** Override the default empty placeholder. */
  emptyFallback?: ReactNode
  /** Render-prop receives `data` once loading/error/empty checks pass. */
  children: (data: T) => ReactNode
}

/**
 * Render-prop component that consolidates the loading/error/empty states that
 * every async dashboard view duplicates. Order of evaluation:
 *
 *   loading > error > empty > render-prop
 *
 * Most views only need to pass `data`, `loading`, `error` and a render-prop —
 * the loading spinner, error panel and "no data" placeholder come for free.
 */
export function AsyncBoundary<T>({
  data,
  loading,
  error,
  isEmpty,
  onRetry,
  loadingFallback,
  errorFallback,
  emptyFallback,
  children,
}: AsyncBoundaryProps<T>) {
  if (loading) {
    return <>{loadingFallback ?? <DefaultLoading />}</>
  }
  if (error) {
    const retry = onRetry ?? (() => {})
    return <>{errorFallback ? errorFallback(error, retry) : <DefaultError error={error} onRetry={retry} />}</>
  }
  if (data == null) {
    return <>{emptyFallback ?? <DefaultEmpty />}</>
  }
  if (isEmpty && isEmpty(data)) {
    return <>{emptyFallback ?? <DefaultEmpty />}</>
  }
  return <>{children(data)}</>
}

function DefaultLoading() {
  return (
    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-ink-muted, #666)' }}>
      Loading…
    </div>
  )
}

function DefaultError({ error, onRetry }: { error: Error | string; onRetry: () => void }) {
  const message = typeof error === 'string' ? error : error.message
  return (
    <div style={{ padding: '24px', textAlign: 'center' }}>
      <div style={{ color: 'var(--color-error, #c33)', marginBottom: '12px' }}>{message}</div>
      <button type="button" onClick={onRetry}>重试</button>
    </div>
  )
}

function DefaultEmpty() {
  return (
    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-ink-muted, #666)' }}>
      暂无数据
    </div>
  )
}