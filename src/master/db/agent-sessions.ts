import { nowBeijing } from "../../shared/time.js";
/**
 * Agent sessions — persistent session registry stored in master DB.
 *
 * Replaces the worker-side `~/.rotom/sessions.json` file. Every chat turn,
 * the worker pushes a `session_snapshot` to master; master upserts each
 * entry here. Invalidated sessions (poisoned history / provider error) are
 * NOT deleted — they're stamped with `invalidated_at` so the dashboard can
 * show full session history per group.
 *
 * Methods attach via `Object.assign`.
 */

import type { TokenUsage } from "../../shared/protocol.js";
import type { MeshDbSelf } from "./core.js";

export interface AgentSessionRow {
  id: number;
  group_id: string;
  agent_name: string;
  cli_tool: string;
  session_id: string;
  created_at: string;
  last_used_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_cost_usd: number | null;
  model: string | null;
  cumulative_cost_usd: number;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_cache_read_tokens: number;
  cumulative_cache_creation_tokens: number;
  invalidated_at: string | null;
}

export interface AgentSessionUpsert {
  groupId: string;
  agentName: string;
  cliTool: string;
  sessionId: string;
  /** 最近一 turn 用量;undefined 表示 worker 还没报告过(只存 sessionId)。 */
  usage?: TokenUsage | null;
  model?: string | null;
  /** 跨该 session 所有 turn 的累计成本。worker 自己累加并上报,
   *  master 不做累加逻辑(worker 是唯一写入方,避免并发累加竞争)。 */
  cumulativeCostUsd?: number;
  /** 累计 token 数,同 cumulativeCostUsd 语义。 */
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  cumulativeCacheReadTokens?: number;
  cumulativeCacheCreationTokens?: number;
}

export const agentSessionMethods = {
  /** 插入或更新一行。usage/model/cumulative 等字段全量覆盖;created_at
   *  首次插入时写入,后续 upsert 不动;last_used_at 每次 upsert 刷新。 */
  upsertAgentSession(this: MeshDbSelf, s: AgentSessionUpsert): void {
    const now = nowBeijing();
    const u = s.usage;
    this.db.prepare(`
      INSERT INTO agent_sessions (
        group_id, agent_name, cli_tool, session_id,
        created_at, last_used_at,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        total_cost_usd, model,
        cumulative_cost_usd,
        cumulative_input_tokens, cumulative_output_tokens,
        cumulative_cache_read_tokens, cumulative_cache_creation_tokens,
        invalidated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(cli_tool, group_id, session_id) DO UPDATE SET
        agent_name                    = excluded.agent_name,
        last_used_at                  = excluded.last_used_at,
        input_tokens                  = COALESCE(excluded.input_tokens, agent_sessions.input_tokens),
        output_tokens                 = COALESCE(excluded.output_tokens, agent_sessions.output_tokens),
        cache_read_tokens             = COALESCE(excluded.cache_read_tokens, agent_sessions.cache_read_tokens),
        cache_creation_tokens         = COALESCE(excluded.cache_creation_tokens, agent_sessions.cache_creation_tokens),
        total_cost_usd                = COALESCE(excluded.total_cost_usd, agent_sessions.total_cost_usd),
        model                         = COALESCE(excluded.model, agent_sessions.model),
        cumulative_cost_usd           = COALESCE(excluded.cumulative_cost_usd, agent_sessions.cumulative_cost_usd),
        cumulative_input_tokens       = COALESCE(excluded.cumulative_input_tokens, agent_sessions.cumulative_input_tokens),
        cumulative_output_tokens      = COALESCE(excluded.cumulative_output_tokens, agent_sessions.cumulative_output_tokens),
        cumulative_cache_read_tokens  = COALESCE(excluded.cumulative_cache_read_tokens, agent_sessions.cumulative_cache_read_tokens),
        cumulative_cache_creation_tokens = COALESCE(excluded.cumulative_cache_creation_tokens, agent_sessions.cumulative_cache_creation_tokens),
        invalidated_at                = NULL
    `).run(
      s.groupId, s.agentName, s.cliTool, s.sessionId,
      now, now,
      u?.inputTokens ?? null,
      u?.outputTokens ?? null,
      u?.cacheReadTokens ?? null,
      u?.cacheCreationTokens ?? null,
      u?.totalCostUsd ?? null,
      s.model ?? null,
      s.cumulativeCostUsd ?? 0,
      s.cumulativeInputTokens ?? 0,
      s.cumulativeOutputTokens ?? 0,
      s.cumulativeCacheReadTokens ?? 0,
      s.cumulativeCacheCreationTokens ?? 0,
    );
  },

  /** 列出该群所有 session(包括已失效的),按最近使用倒序。Dashboard 用。 */
  listAgentSessionsByGroup(this: MeshDbSelf, groupId: string): AgentSessionRow[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE group_id = ? ORDER BY invalidated_at IS NOT NULL, last_used_at DESC",
    ).all(groupId) as AgentSessionRow[];
  },

  /** 列出某 agent + cliTool 的所有 active session(未失效)。worker 启动时
   *  master 推 session_sync_push 用。 */
  listActiveAgentSessions(this: MeshDbSelf, agentName: string, cliTool: string): AgentSessionRow[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE agent_name = ? AND cli_tool = ? AND invalidated_at IS NULL ORDER BY last_used_at DESC",
    ).all(agentName, cliTool) as AgentSessionRow[];
  },

  /** 标记失效:不删除行,只打 invalidated_at 戳。保留历史。 */
  invalidateAgentSession(this: MeshDbSelf, cliTool: string, groupId: string, sessionId: string): boolean {
    const now = nowBeijing();
    const r = this.db.prepare(
      "UPDATE agent_sessions SET invalidated_at = ? WHERE cli_tool = ? AND group_id = ? AND session_id = ?",
    ).run(now, cliTool, groupId, sessionId);
    return r.changes > 0;
  },

  /** 硬删除:Dashboard 用户主动删 session 时调用。 */
  deleteAgentSession(this: MeshDbSelf, cliTool: string, groupId: string, sessionId: string): boolean {
    const r = this.db.prepare(
      "DELETE FROM agent_sessions WHERE cli_tool = ? AND group_id = ? AND session_id = ?",
    ).run(cliTool, groupId, sessionId);
    return r.changes > 0;
  },

  /** 反查单条(按 sessionId)。GET /sessions/:.../usage 用。 */
  findAgentSession(this: MeshDbSelf, sessionId: string): AgentSessionRow | undefined {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE session_id = ? ORDER BY invalidated_at IS NOT NULL, last_used_at DESC LIMIT 1",
    ).get(sessionId) as AgentSessionRow | undefined;
  },
};
