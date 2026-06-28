-- 034: ask_bridges —— Agent A 向 Agent B 提问后的「等回复 + 超时兜底」bridge 记录。
--
-- 生命周期:
--   pending     A 调 rotom ask 发问,bridge 建立,5min 定时器开始
--   answered     scheduler tick 检测到 B @ A(mentions 含 A),自动 cancel
--   timed_out   5min 到点未 @,scheduler 创建 Issue 给 A(复述 B 的非@回复,或指示升级),bridge 闭环
--   cancelled   A 主动 rotom ask cancel,或 A 撤销问题
--
-- scheduler 每 30s tick 扫 pending 行:
--   1. 先查 B 是否 @ 过 A → mark answered
--   2. expires_at < now → 查 B 的非@回复,创建 Issue(复述/升级),mark timed_out
--
-- 详细设计见 docs/AGENT_ASK_REPLY_TIMER.md 方案 C。
CREATE TABLE ask_bridges (
  id              TEXT PRIMARY KEY,         -- uuid
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  asker           TEXT NOT NULL,            -- Agent A (发起方)
  target          TEXT NOT NULL,            -- Agent B (被问方)
  question_msg_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  escalate_to     TEXT,                     -- 真人 agent 名;NULL = A 自己挑
  timeout_ms      INTEGER NOT NULL,         -- 默认 300000 (5min)
  created_at      INTEGER NOT NULL,         -- epoch ms
  expires_at      INTEGER NOT NULL,         -- created_at + timeout_ms
  status          TEXT NOT NULL DEFAULT 'pending',
  reply_msg_id    INTEGER REFERENCES group_messages(id) ON DELETE SET NULL,
  resolved_at     INTEGER,                  -- answered/timed_out/cancelled 的时间戳
  issue_id        TEXT REFERENCES issues(id) ON DELETE SET NULL,
  CHECK (status IN ('pending','answered','timed_out','cancelled'))
);
CREATE INDEX idx_ask_bridges_pending ON ask_bridges(expires_at) WHERE status = 'pending';
CREATE INDEX idx_ask_bridges_lookup ON ask_bridges(group_id, target, status);
CREATE INDEX idx_ask_bridges_asker ON ask_bridges(asker, status);
