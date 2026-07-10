/**
 * Skill 极简指针层 —— prompt 末尾一行,告诉 agent 有多少可用 skill + 怎么查。
 *
 * skill 是非核心工作(能力,不是当前任务上下文),绝不展开 content、不抢核心任务 prompt。
 * agent 按需 `rotom skill mine <groupId>` / `rotom skill get <name>` 拉取。
 *
 * count=0 → 不注入。
 */

import type { PromptLayer } from "./prompt-composer.js"

export interface SkillPointer {
  count: number
  groupId?: string
}

export function buildSkillPointerLayer(p: SkillPointer): PromptLayer | null {
  if (p.count === 0) return null
  const groupIdHint = p.groupId ? ` <groupId>` : ""
  return {
    layer: "skill-pointer",
    slot: "user",
    content:
      `[可用技能] ${p.count} 个。用 \`rotom skill mine${groupIdHint}\` 查列表,` +
      `\`rotom skill get <name>\` 看详情;无关技能忽略,不要硬套。\n`,
    source: "agent_skill_bindings count (runtime, group+agent scoped)",
  }
}
