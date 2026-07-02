import { api } from './client'
import type { Issue, IssueEvent, CreateIssueDto } from './types'

export interface IssueDetail extends Issue {
  events: IssueEvent[]
}

export interface IssueMessage {
  id: number
  round: number
  agentName: string
  content: string
  createdAt: string
}

export const issuesApi = {
  async listByGroup(groupId: string, status?: string, type?: string): Promise<Issue[]> {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (type) params.set('type', type)
    const qs = params.toString()
    return api.get<Issue[]>(`/groups/${groupId}/issues${qs ? `?${qs}` : ''}`)
  },

  async listAll(status?: string): Promise<Issue[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : ''
    return api.get<Issue[]>(`/issues${qs}`)
  },

  /** 分页拉取全量 issue。看板每列独立分页,避免 completed/cancelled 累积过多
   *  时把整张表拖到前端。total 是不带 limit/offset 的全量计数,给列头展示
   *  真实总数;items 是当前页。 */
  async listPage(
    status: Issue['status'] | undefined,
    limit: number,
    offset: number,
  ): Promise<{ items: Issue[]; total: number }> {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    return api.get<{ items: Issue[]; total: number }>(`/issues?${params.toString()}`)
  },

  async create(groupId: string, data: CreateIssueDto): Promise<{ id: string; title: string; status: string }> {
    return api.post<{ id: string; title: string; status: string }>(`/groups/${groupId}/issues`, data)
  },

  async getById(id: string): Promise<IssueDetail> {
    return api.get<IssueDetail>(`/issues/${id}`)
  },

  async update(
    id: string,
    data: { assignedTo?: string; priority?: string; title?: string; description?: string; approvalPolicy?: 'r_allow' | 'rw_allow' },
  ): Promise<{ ok: boolean }> {
    return api.put<{ ok: boolean }>(`/issues/${id}`, data)
  },

  async cancel(id: string, cancelledBy: string): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/issues/${id}/cancel`, { cancelledBy })
  },

  /** 中断当前步骤但保留 issue in_progress(对齐 codex CLI 的 ESC)。
   *  与 cancel 的区别:不翻转 status,session_id 保留,worker abort 后由
   *  runIssueExecution 的 finally 块决定是否 --resume 续跑(pendingAppends
   *  非空时合并队列续跑,空则保持 idle 等用户下一次 append)。 */
  async interrupt(id: string, interruptedBy: string): Promise<{ ok: boolean; delivered: boolean }> {
    return api.post<{ ok: boolean; delivered: boolean }>(`/issues/${id}/interrupt`, { interruptedBy })
  },

  /** Resolve a pending approval the executor raised mid-issue.
   *  `feedback` is only meaningful on `deny` — it's the free-text rejection
   *  reason that gets forwarded to the executor as a meaningful denial
   *  message and persisted on the resolved card. */
  async respondApproval(
    issueId: string,
    approvalId: string,
    decision: 'accept' | 'deny',
    resolvedBy?: string,
    feedback?: string,
  ): Promise<{ ok: boolean }> {
    const body: Record<string, string> = { decision }
    if (resolvedBy) body.resolvedBy = resolvedBy
    if (decision === 'deny' && feedback && feedback.trim()) body.feedback = feedback.trim()
    return api.post<{ ok: boolean }>(`/issues/${issueId}/approvals/${approvalId}`, body)
  },

  async getEvents(id: string): Promise<IssueEvent[]> {
    return api.get<IssueEvent[]>(`/issues/${id}/events`)
  },

  async getMessages(id: string): Promise<IssueMessage[]> {
    return api.get<IssueMessage[]>(`/issues/${id}/messages`)
  },

  async complete(id: string, completedBy: string): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/issues/${id}/complete`, { completedBy })
  },

  /** 在 issue 已 completed/failed 后追加一条新输入,基于上一次执行返回的
   *  sessionId 续聊。后端会把 issue 状态回退到 in_progress 并通过 WS
   *  唤起 assigned_to agent 再次执行。 */
  async continue(
    id: string,
    prompt: string,
    continuedBy: string,
  ): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>(`/issues/${id}/continue`, { prompt, continuedBy })
  },

  /** 在 issue 仍处于 open/in_progress 时排队一条追加指令。worker 端会在
   *  当前一轮 CLI 跑完后自动 --resume 起新一轮。与 continue 互补:continue
   *  只接受终态,append 只接受 active 态。 */
  async append(
    id: string,
    prompt: string,
    appendedBy: string,
  ): Promise<{ ok: boolean; queued: boolean }> {
    return api.post<{ ok: boolean; queued: boolean }>(`/issues/${id}/append`, { prompt, appendedBy })
  },

  async delete(id: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/issues/${id}`)
  },

  /** 对 completed 的 Issue 触发「生成记忆」:创建一个记忆提取任务 Issue push 给 agent。
   *  agent 读原 Issue 产出 → 提炼记忆 → 调 rotom memory add --pending 写入待审核池。 */
  async extractMemory(id: string, agentName?: string): Promise<{ extractIssueId: string; agentName: string; pushed: boolean }> {
    return api.post<{ extractIssueId: string; agentName: string; pushed: boolean }>(`/issues/${id}/extract-memory`, { agentName })
  },
}
