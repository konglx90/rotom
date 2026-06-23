/**
 * Share / Visitor API client.
 *
 * Management endpoints (create / revoke) are called from a logged-in Dashboard
 * context and require the agent's mesh_ Bearer token. Visitor read paths are
 * reached automatically via the api client's `?share=` prefix — see
 * api/client.ts — so visitors never call `shareApi.*` for reading.
 *
 * The dashboard's regular `api` client does not inject auth headers (it's
 * browseable without an identity). These two endpoints are special — they
 * 401 without Bearer — so we call fetch directly here.
 */

export interface ShareToken {
  token: string
  groupId: string
  createdBy: string
  createdAt: number
}

async function authedJson<T>(path: string, init: RequestInit): Promise<T> {
  const token = localStorage.getItem('chat_agent_token') || ''
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`/api${path}`, { ...init, headers })
  const text = await res.text()
  const data = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `HTTP ${res.status}`)
  }
  return data as T
}

export const shareApi = {
  async create(groupId: string): Promise<ShareToken> {
    return authedJson<ShareToken>(`/groups/${groupId}/shares`, { method: 'POST' })
  },

  async revoke(token: string): Promise<{ ok: boolean }> {
    return authedJson<{ ok: boolean }>(`/shares/${token}`, { method: 'DELETE' })
  },
}