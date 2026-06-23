import type { Agent } from '../../api/types'

/**
 * 将 issue.assigned_to(agent.name)解析为列表/卡片上的展示文案。
 * - 未指派 → null,调用方自行展示占位(「未认领」)
 * - 在线/离线都能找到 → 返回 agent.name
 * - assigned_to 非空但 agents 列表里查不到(agent 已下线/退群/老数据)→
 *   退回到原始字符串,避免空值,同时保留可读性
 *
 * NOTE: 等 #af06f47d agent 昵称落地后,这里优先返回 nickname。
 */
export function resolveAssigneeName(
  assignedTo: string | null | undefined,
  agents: Agent[],
): string | null {
  if (!assignedTo) return null
  const hit = agents.find(a => a.name === assignedTo)
  return hit?.name ?? assignedTo
}

/** 未指派时列表/卡片上展示的占位文案。统一从这里导出,避免散落不一致。 */
export const UNCLAIMED_LABEL = '未认领'
