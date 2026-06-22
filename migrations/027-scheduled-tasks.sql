-- 027 — Scheduled tasks (群内定时任务)
-- 时间戳统一用 INTEGER ms (Unix epoch),由调度器进程维护 next_run_at,
-- 不复用 issues 表的 datetime('now') TEXT 约定 —— 毫秒级比较更直观。
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  group_id        TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'agent' CHECK (mode IN ('agent','message')),
  agent_name      TEXT,                          -- 仅 mode='agent' 必填
  schedule_kind   TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_kind IN ('once','interval')),
  interval_sec    INTEGER,                       -- schedule_kind='interval' 时必填,>= 30
  run_at          INTEGER,                       -- schedule_kind='once' 时:目标时间戳(ms)
  prompt          TEXT NOT NULL,                 -- agent 模式:派给 agent 的指令;message 模式:直接发到群里的文本
  enabled         INTEGER NOT NULL DEFAULT 1,
  next_run_at     INTEGER NOT NULL,              -- 下次运行时间(ms),由调度器维护
  last_run_at     INTEGER,
  last_status     TEXT,                          -- 'ok' | 'error' | 'skipped'
  last_error      TEXT,
  last_issue_id   TEXT,                          -- 仅 agent 模式会用
  repeat_times    INTEGER,                       -- NULL=无限,N=跑 N 次后自动 enabled=0
  repeat_count    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);