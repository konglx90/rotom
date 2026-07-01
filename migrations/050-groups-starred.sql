-- 050: Add starred_at column to groups table.
-- NULL = 普通活跃群; non-NULL timestamp = 重要少用群(可读可写,仅作侧栏分层).
-- 区别于 archived_at(只读):starred 群仍可发消息/建 issue,只是不常用。
ALTER TABLE groups ADD COLUMN starred_at TEXT;
