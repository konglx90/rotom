-- 041: 修复 agent_memory.group_id 的 NOT NULL 约束
--
-- 040 从 notes 升级时继承了 notes 表的 `group_id TEXT NOT NULL` 约束,
-- 但 scope='global' 的记忆需要 group_id=NULL。SQLite 不能直接 ALTER 改列约束,
-- 必须重建表(标准 12 步流程)。
--
-- 重建后 group_id 允许 NULL(scope='global' 时为 NULL)。

PRAGMA foreign_keys=OFF;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS agent_memory_new (
  id            TEXT PRIMARY KEY,
  group_id      TEXT REFERENCES groups(id) ON DELETE CASCADE,  -- 允许 NULL(scope=global)
  scope         TEXT NOT NULL DEFAULT 'group' CHECK (scope IN ('group','global')),
  category      TEXT NOT NULL DEFAULT 'note' CHECK (category IN ('fact','decision','convention','pitfall','todo','playbook','note')),
  source_type   TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','issue_summary')),
  source_ref    TEXT,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  summary       TEXT,
  tags          TEXT DEFAULT '[]',
  visibility    TEXT NOT NULL DEFAULT 'group' CHECK (visibility IN ('private','group','global')),
  agent_visible INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  expires_at    TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  pending_review INTEGER NOT NULL DEFAULT 0,
  injected_count INTEGER NOT NULL DEFAULT 0,
  view_count    INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);

INSERT INTO agent_memory_new (
  id, group_id, scope, category, source_type, source_ref,
  key, value, summary, tags, visibility, agent_visible,
  created_by, created_at, updated_at, expires_at,
  active, pending_review, injected_count, view_count, last_viewed_at
)
SELECT
  id, group_id, scope, category, source_type, source_ref,
  key, value, summary, tags, visibility, agent_visible,
  created_by, created_at, updated_at, expires_at,
  active, pending_review, injected_count, view_count, last_viewed_at
FROM agent_memory;

DROP TABLE agent_memory;
ALTER TABLE agent_memory_new RENAME TO agent_memory;

-- 重建索引(040 已建但 DROP TABLE 时一起没了)
CREATE INDEX IF NOT EXISTS idx_memory_scope_group ON agent_memory(scope, group_id, agent_visible, active, pending_review, category);
CREATE INDEX IF NOT EXISTS idx_memory_key ON agent_memory(scope, group_id, key, active, agent_visible);
CREATE INDEX IF NOT EXISTS idx_memory_global ON agent_memory(scope, active, pending_review, agent_visible) WHERE scope='global';
CREATE INDEX IF NOT EXISTS idx_memory_stale ON agent_memory(active, agent_visible, view_count, last_viewed_at);
CREATE INDEX IF NOT EXISTS idx_notes_group ON agent_memory(group_id, created_at);  -- 旧兼容

COMMIT;

PRAGMA foreign_keys=ON;
