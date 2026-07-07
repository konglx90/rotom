# Sessions & cost(session 注册表 + token/成本累计)

agent 在每个群里的会话(session)持久化在 master DB,跟踪 token 用量与累计成本;失效会话不删,打戳保留历史。

## 1. 概念

底层 CLI(claude/codex/…)有自己的 session 概念(多 turn 复用上下文)。rotom 把这些 session 注册到 master DB,以便:Dashboard 展示某群下所有 session 历史;worker 重连后 master 推 `session_sync_push` 让 worker 恢复;失效 session(poisoned history / provider error)不删,打 `invalidated_at` 戳保留审计。

## 2. 数据模型(`agent_sessions`)

| 列 | 含义 |
|---|---|
| `group_id` / `agent_name` / `cli_tool` | 归属三元组 |
| `session_id` | 底层 CLI 的 session id |
| `created_at` / `last_used_at` | 首次写入 / 最近一次 upsert |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens` | **最近一 turn** 用量 |
| `total_cost_usd` / `model` | 最近一 turn 成本与模型 |
| `cumulative_cost_usd` / `cumulative_*_tokens` | **跨该 session 所有 turn 累计**(worker 上报,master 不累加) |
| `invalidated_at` | 失效戳;NULL = active |

UNIQUE: `(cli_tool, group_id, session_id)` —— 同 session upsert 不新增。

## 3. upsert 语义(易踩坑)

- `created_at` 仅首次插入写,后续 upsert 不动。
- `last_used_at` 每次 upsert 刷新。
- `usage` / `model` / `cumulative_*` 用 `COALESCE(excluded.*, old.*)` —— **未传字段保留旧值**(worker 还没报告用量时只存 sessionId)。
- `invalidated_at` 在 upsert 时被清成 NULL —— **失效 session 再收到 snapshot 会"复活"**(worker 重连场景)。
- 累计字段由 worker 自己累加上报(master 是唯一写入方,避免并发累加竞争)。

## 4. 关键文件

- `src/master/db/agent-sessions.ts` —— `upsertAgentSession` / `listAgentSessionsByGroup` / `listActiveAgentSessions` / `invalidateAgentSession` / `deleteAgentSession` / `findAgentSession`
- `src/master/ws-hub/connection.ts` —— `session_sync_push`(worker 启动时 master 推 active sessions)、`session_snapshot`/`session_invalidated`(worker → master)
- `tests/db-sessions-links.test.ts` —— upsert / COALESCE / 失效 / 复活 / 删除 / 反查用例

## 5. 协议消息

- `session_sync_push`(master→worker):worker 启动时把该 (agent, cli) 的 active sessions 推下去恢复。
- `session_snapshot`(worker→master):每 turn 结束 worker 推最新用量,master upsert。
- `session_invalidated`(worker→master):worker 主动声明某 session 失效,master 打戳。

## 6. 与其他子系统关系

- **Issue**:`issues.session_id` / `cli_tool` 指向所用 session,continue 路径靠它 resume。
- **Artifacts**:worktree 与 session 绑定。
- **Dashboard**:群对话右侧"Process"面板有 Session 调试视图(查看/复制/删除)。
