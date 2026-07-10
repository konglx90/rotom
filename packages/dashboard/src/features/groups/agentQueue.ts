import type { ChatMessage } from './types'

export type QueueItemState = 'processing' | 'queued'

export interface QueueItem {
  requestId: string
  from: string
  content: string
  timestamp: Date
  state: QueueItemState
  /** 1-based position among the waiting (queued) items. Processing items carry no position. */
  position?: number
}

export interface AgentQueue {
  agentName: string
  /** Whether this agent currently has an in-flight reply (streaming / loading bubble). */
  active: boolean
  /** Processing items first, then queued items by position. */
  items: QueueItem[]
}

/**
 * 前端推断:从当前群的消息状态推导每个被 @ 的 agent 的待处理队列。
 *
 * 模型:FIFO 消费。把发给 T 的 demand 按时间排队,每个「回复事件」从队首消费掉最多
 * MAX_MERGE(=3)条(对齐 worker 的合并出队)。消费完仍留在队里的 = queued;被最后一个
 * 回复事件消费、且 T 此刻在忙的那批 = processing;其余已答过的 = done(隐藏)。
 *
 * 回复事件来源(两路,去重避免重复计数):
 *  - live turn 起点:turnStartsByAgent ref 记的「流首个 chunk 到达时刻」。用起点而非
 *    持久化消息的 created_at(≈turn 结束)—— 保证「agent 回上一轮时又 @ 他」的消息
 *    (turn 进行中发出)不被本 turn final 消息偏晚的时间戳误消费。
 *  - 历史 reply:messages 里 T 的真实回复消息(流式气泡 / 持久化 final,排除 loading 占位)
 *    中,没有对应 turnStart 的最旧若干条 —— 覆盖打开会话前就已答完的旧消息。
 *    turnStarts 与最近若干条 reply 一一配对(live = 最近发生的),故历史 reply 取最旧
 *    replyTimes.length - turnStarts.length 条。
 *
 * 这是推断而非权威:无法确认 worker 真的收到并入队,合并按 MAX_MERGE 近似。详见计划
 * 文档「全栈方案备注」。
 */
const MAX_MERGE = 3
export function deriveAgentQueues(
  messages: ChatMessage[],
  turnStartsByAgent: Map<string, number[]>,
  myAgentName: string,
  /** DM 模式:一对一对话没有 @ 标记,把所有发出消息都当作对该 target 的 demand。 */
  directTarget?: string,
): AgentQueue[] {
  // 候选 agent:DM 模式只有一个 target;群聊模式 = 所有「发出消息」的 @ 目标(排除自己)。
  const targets: string[] = []
  if (directTarget) {
    targets.push(directTarget)
  } else {
    const targetSet = new Set<string>()
    for (const m of messages) {
      if (m.isIncoming || m.truncated) continue
      for (const name of m.mentions ?? []) {
        if (name && name !== myAgentName) targetSet.add(name)
      }
    }
    targets.push(...targetSet)
  }

  const queues: AgentQueue[] = []

  for (const agentName of targets) {
    const demands = messages
      .filter(
        m =>
          !m.isIncoming &&
          !m.truncated &&
          !!m.content &&
          (directTarget ? true : (m.mentions ?? []).includes(agentName)),
      )
      .map(m => ({
        id: m.id,
        from: m.from,
        content: m.content,
        timestamp: m.timestamp,
        time: m.timestamp.getTime(),
      }))
      .sort((a, b) => a.time - b.time)

    if (demands.length === 0) continue

    // T 的真实回复消息时间(流式气泡 / 持久化 final;排除 loading 占位)。
    // 一条 turn 在任意时刻只表现为其中一种(流式中 = stream 气泡,结束后 = final),
    // 故每个 reply 只计一次。
    const replyTimes = messages
      .filter(
        m =>
          m.isIncoming &&
          m.from === agentName &&
          !m.truncated &&
          (m.streaming || (!!m.content && !m.isLoading)),
      )
      .map(m => m.timestamp.getTime())
      .sort((a, b) => a - b)

    const turnStarts = (turnStartsByAgent.get(agentName) ?? [])
      .slice()
      .sort((a, b) => a - b)

    // 回复事件 = live turn 起点 ∪ 历史 reply。live turn 与最近的若干条 reply 一一配对
    // (live = 最近发生的),用 turn 起点时刻;没有对应 turnStart 的最旧若干条 reply 才算
    // 历史事件(用其自身时刻)。这样 live turn 的 final 消息(时刻偏晚)不会单独再算一次,
    // 避免把「turn 进行中发出的」消息误消费。
    const numLive = Math.min(turnStarts.length, replyTimes.length)
    const historicalReplyTimes = replyTimes.slice(0, replyTimes.length - numLive)
    const turnEvents = [...turnStarts, ...historicalReplyTimes].sort((a, b) => a - b)

    const active = messages.some(
      m => m.isIncoming && m.from === agentName && (m.streaming || m.isLoading),
    )

    // FIFO 消费:demand 与 turnEvent 按时间排成时间线,每个 turnEvent 从队首吃掉最多
    // MAX_MERGE 条(对齐 worker 出队合并)。留在队里的 = 待处理。
    type DemandInfo = { id: string; from: string; content: string; timestamp: Date; time: number }
    const timeline: Array<{ kind: 'demand'; d: DemandInfo; t: number } | { kind: 'turn'; d: null; t: number }> = []
    for (const d of demands) timeline.push({ kind: 'demand', d, t: d.time })
    for (const t of turnEvents) timeline.push({ kind: 'turn', d: null, t })
    // 同时刻 demand 排在 turn 前面,保证"恰好同时"的 demand 先入队。
    timeline.sort((a, b) => a.t - b.t || (a.kind === 'demand' ? -1 : 1))

    let pending: DemandInfo[] = []
    let lastConsumed: DemandInfo[] = []
    for (const ev of timeline) {
      if (ev.kind === 'demand') {
        pending.push(ev.d)
      } else {
        const batch = pending.splice(0, Math.min(MAX_MERGE, pending.length))
        if (batch.length > 0) lastConsumed = batch
      }
    }

    // processing = 当前活跃 turn 正在处理的那一批(lastConsumed)。若活跃但还没消费到
    // (loading 占位、首 chunk 未到),且没有"早于队首"的活跃 turn,把队首提升为 processing。
    let processing: DemandInfo[] = active ? lastConsumed : []
    let queued = pending
    if (active && processing.length === 0 && queued.length > 0) {
      const front = queued[0]
      const hasEarlierActiveTurn = turnStarts.some(s => s <= front.time)
      if (!hasEarlierActiveTurn) {
        processing = [queued.shift()!]
      }
    }

    const items: QueueItem[] = [
      ...processing.map(d => ({
        requestId: d.id,
        from: d.from,
        content: d.content,
        timestamp: d.timestamp,
        state: 'processing' as const,
      })),
      ...queued.map((d, i) => ({
        requestId: d.id,
        from: d.from,
        content: d.content,
        timestamp: d.timestamp,
        state: 'queued' as const,
        position: i + 1,
      })),
    ]
    if (items.length === 0) continue

    queues.push({ agentName, active, items })
  }

  // 正在忙的 agent 排前面;其次按名字稳定排序。
  queues.sort(
    (a, b) => Number(b.active) - Number(a.active) || a.agentName.localeCompare(b.agentName),
  )
  return queues
}
