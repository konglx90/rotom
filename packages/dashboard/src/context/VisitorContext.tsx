/**
 * Visitor mode context.
 *
 * Activated when the URL carries `?share=<token>`. On mount, validates the
 * token by hitting `GET /api/share/<token>/groups/<id>` (where `<id>` is
 * resolved from the route param once available — see below). On success,
 * sets `isVisitor=true` and exposes the token + bound group id. On failure,
 * sets `error` so the host can render an "invalid link" page.
 *
 * State is in-memory only — no localStorage. Refreshing re-validates.
 *
 * Note: validation is deferred until the host component knows which group id
 * the URL is targeting (call `validate(groupId)` from the page). This avoids
 * a second request: the host page already needs to fetch the group, so the
 * visitor flow piggybacks on that fetch by checking 401 vs 200.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

interface VisitorState {
  token: string | null
  groupId: string | null
  error: string | null
}

interface VisitorContextValue extends VisitorState {
  /** True only when a token is present in the URL AND validation succeeded. */
  isVisitor: boolean
  /** Validate the share token against a specific group id. Called by host. */
  validate(groupId: string): Promise<boolean>
  /** Manually clear the visitor state (used by the "Invalid link" UI). */
  reset(): void
}

const VisitorContext = createContext<VisitorContextValue | null>(null)

function readTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  return params.get('share')
}

export function VisitorProvider({ children }: { children: React.ReactNode }) {
  const urlToken = useMemo(() => readTokenFromUrl(), [])
  const [state, setState] = useState<VisitorState>({
    token: urlToken,
    groupId: null,
    error: urlToken ? null : null,
  })

  const validate = useCallback(
    async (groupId: string): Promise<boolean> => {
      if (!urlToken) return false
      try {
        // The api client will rewrite this URL to /api/share/<token>/groups/<id>.
        // 200 → valid; 401 → invalid / expired.
        const res = await fetch(`/api/share/${urlToken}/groups/${groupId}`, {
          headers: { 'Content-Type': 'application/json' },
        })
        if (res.ok) {
          setState({ token: urlToken, groupId, error: null })
          return true
        }
        setState({
          token: urlToken,
          groupId: null,
          error: '分享链接无效或已过期',
        })
        return false
      } catch {
        setState({
          token: urlToken,
          groupId: null,
          error: '验证分享链接失败',
        })
        return false
      }
    },
    [urlToken],
  )

  const reset = useCallback(() => {
    setState({ token: null, groupId: null, error: null })
  }, [])

  // isVisitor 的判定只看 token 是否存在 + 没有显式 error,不看 groupId ——
  // groupId 在 host page 调 validate(groupId) 成功后才填。如果在这里要求
  // groupId,RequireAgent 在 validate 完成前就会判定非访客 + 把用户弹回
  // /dashboard/agents,validate 永远跑不到。
  const value: VisitorContextValue = {
    ...state,
    isVisitor: !!state.token && !state.error,
    validate,
    reset,
  }

  return <VisitorContext.Provider value={value}>{children}</VisitorContext.Provider>
}

export function useVisitorMode(): VisitorContextValue {
  const ctx = useContext(VisitorContext)
  if (!ctx) {
    throw new Error('useVisitorMode must be used within a VisitorProvider')
  }
  return ctx
}