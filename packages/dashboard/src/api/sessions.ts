import { api } from './client'
import type { TokenUsage } from './types'

/** One session entry — one (cliTool, groupId, sessionId) tuple as reported
 *  by a single executor worker. */
export interface SessionEntry {
  cliTool: string
  groupId: string
  sessionId: string
}

/** View content response. `error` is non-empty when the executor's CLI
 *  backend doesn't support introspection (codex/hermes/openclaw) or the
 *  transcript is gone. `content` may be empty in that case. */
export interface SessionView {
  cliTool: string
  groupId: string
  sessionId: string
  format: 'jsonl' | 'text' | 'raw'
  content: string
  error?: string
}

/** Session usage / model —— Debug 视图反查最新绑定该 session 的 issue。 */
export interface SessionUsage {
  cliTool: string
  sessionId: string
  /** Parsed TokenUsage,null 表示该 session 还没有完成过 issue。 */
  usage: TokenUsage | null
  model: string | null
  /** usage/model 来源 issue 的 id。 */
  issueId: string | null
}

export const sessionsApi = {
  /** List all (cliTool, sessionId) pairs the dashboard can see for a group. */
  async list(groupId: string): Promise<{ sessions: SessionEntry[] }> {
    return api.get<{ sessions: SessionEntry[] }>(
      `/sessions?groupId=${encodeURIComponent(groupId)}`,
    )
  },

  /** Read the tail of a session transcript. Default 200 lines, max 2000. */
  async view(
    cliTool: string,
    groupId: string,
    sessionId: string,
    tail = 200,
  ): Promise<SessionView> {
    return api.get<SessionView>(
      `/sessions/${encodeURIComponent(cliTool)}/${encodeURIComponent(groupId)}/${encodeURIComponent(sessionId)}?tail=${tail}`,
    )
  },

  /** Drop the sessionId from the executor's SessionStore. The next chat or
   *  issue run will start a fresh session instead of --resume'ing this one. */
  async delete(cliTool: string, groupId: string, sessionId: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(
      `/sessions/${encodeURIComponent(cliTool)}/${encodeURIComponent(groupId)}/${encodeURIComponent(sessionId)}`,
    )
  },

  /** 反查最新绑定该 session 的 issue 的 token usage / model。
   *  用于 Debug 视图 SessionPanel 在每个 session 条目下展示。 */
  async usage(
    cliTool: string,
    groupId: string,
    sessionId: string,
  ): Promise<SessionUsage> {
    return api.get<SessionUsage>(
      `/sessions/${encodeURIComponent(cliTool)}/${encodeURIComponent(groupId)}/${encodeURIComponent(sessionId)}/usage`,
    )
  },
}
