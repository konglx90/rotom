-- 038: agent_sessions —— 把 worker 侧的 SessionStore (~/.rotom/sessions.json)
-- 迁移到 master DB。每个 (cli_tool, group_id, session_id) 一行,永久保留
-- 历史(包括已失效的 session,用 invalidated_at 标记)。
--
-- 替代了 src/executor/session-store.ts 的 JSON 文件持久化:
--   - worker 启动时从 master DB 拉自己的 active sessions (session_sync_push)
--   - worker 每次 turn 后推 session_snapshot,master upsert 到本表
--   - worker 失效 session 时推 session_invalidated,master 打 invalidated_at
--   - Dashboard GET /sessions 直接读本表,online 由 connections join 算出
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id                TEXT NOT NULL,
  agent_name              TEXT NOT NULL,
  cli_tool                TEXT NOT NULL,
  session_id              TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- 最近一 turn 用量(每次 upsert 覆盖)
  input_tokens            INTEGER,
  output_tokens           INTEGER,
  cache_read_tokens       INTEGER,
  cache_creation_tokens   INTEGER,
  total_cost_usd          REAL,
  model                   TEXT,
  -- 跨该 session 所有 turn 的 total_cost_usd 累加
  cumulative_cost_usd     REAL NOT NULL DEFAULT 0,
  -- worker 标记失效时(poison / provider error)打戳;NULL = 仍 active
  invalidated_at          TEXT NULL,
  UNIQUE(cli_tool, group_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_group ON agent_sessions(group_id, last_used_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_name, cli_tool, invalidated_at);
