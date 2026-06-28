/**
 * Agent 档案 —— `agents.profile` 列存的 JSON 字符串的解析。
 *
 * 字段定义见 `src/shared/protocol.ts:AgentProfile`(本文件 re-export 保持旧 import path 兼容)。
 * 本文件只做"JSON 字符串 → 强类型"还原,容忍 null/损坏输入(返回 null 而不是抛错,
 * 因为运行时 prompt 渲染可以接受缺角色)。
 */

import type { AgentProfile } from "./protocol.js";
export type { AgentProfile };

export function parseAgentProfile(json: string | null | undefined): AgentProfile | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    const out: AgentProfile = {};
    if (typeof obj.category === "string") out.category = obj.category;
    if (typeof obj.position === "string") out.position = obj.position;
    if (typeof obj.bio === "string") out.bio = obj.bio;
    return out;
  } catch {
    return null;
  }
}

/**
 * 群级别 profile 覆盖 merge 到 agent 全局 profile 上,群级别非 undefined 字段胜出。
 * 供 dispatch-enrich(WS 推送 self profile)与 GET /groups/:id(返回群成员花名册)共用,
 * 避免两份 merge 逻辑漂移。
 */
export function mergeGroupProfile(base: AgentProfile | null | undefined, group: AgentProfile | null): AgentProfile | undefined {
  if (!group) return base ?? undefined;
  const merged: AgentProfile = { ...(base ?? {}) };
  if (typeof group.category === "string") merged.category = group.category;
  if (typeof group.position === "string") merged.position = group.position;
  if (typeof group.bio === "string") merged.bio = group.bio;
  return merged;
}
