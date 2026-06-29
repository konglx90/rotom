-- 040: 升级 notes 表为 agent_memory
--
-- notes 原本是纯人看的群级便签(title + description),agent 完全不可见。
-- 本 migration 把 notes 升级为统一的"记忆"载体:
--   - agent_visible=0  → note(纯人看,agent search/get/prompt 全部排除)
--   - agent_visible=1  → memory(agent 可见,走 search/get/注入)
-- 旧 note 默认 backfill agent_visible=0,保持现状。
--
-- 字段映射:note.title → key, note.description → value, summary 自动取 value 前 80 字符。
-- 表名 rename: notes → agent_memory,代码语义统一。
-- 旧 /groups/:id/notes 路由 + rotom note CLI 保留作兼容别名。

-- 1. 加列(SQLite ALTER 逐列加,带默认值)
ALTER TABLE notes ADD COLUMN scope          TEXT NOT NULL DEFAULT 'group' CHECK (scope IN ('group','global'));
ALTER TABLE notes ADD COLUMN category       TEXT NOT NULL DEFAULT 'note' CHECK (category IN ('fact','decision','convention','pitfall','todo','playbook','note'));
ALTER TABLE notes ADD COLUMN source_type    TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','issue_summary'));
ALTER TABLE notes ADD COLUMN source_ref     TEXT;
ALTER TABLE notes ADD COLUMN summary        TEXT;
ALTER TABLE notes ADD COLUMN tags           TEXT DEFAULT '[]';
ALTER TABLE notes ADD COLUMN visibility     TEXT NOT NULL DEFAULT 'group' CHECK (visibility IN ('private','group','global'));
ALTER TABLE notes ADD COLUMN agent_visible  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN expires_at      TEXT;
ALTER TABLE notes ADD COLUMN active          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notes ADD COLUMN pending_review  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN injected_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN view_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_viewed_at  TEXT;

-- 2. backfill summary(取 description 前 80 字符)
UPDATE notes SET summary = substr(description, 1, 80) WHERE summary IS NULL;

-- 2b. 字段语义重命名:note.title → key, note.description → value
--     (旧 notes 是 title+description 两段;升级后用 key+value 与 memory 语义统一)
ALTER TABLE notes RENAME COLUMN title TO key;
ALTER TABLE notes RENAME COLUMN description TO value;

-- 3. rename 表
ALTER TABLE notes RENAME TO agent_memory;

-- 4. 索引
CREATE INDEX IF NOT EXISTS idx_memory_scope_group ON agent_memory(scope, group_id, agent_visible, active, pending_review, category);
CREATE INDEX IF NOT EXISTS idx_memory_key ON agent_memory(scope, group_id, key, active, agent_visible);
CREATE INDEX IF NOT EXISTS idx_memory_global ON agent_memory(scope, active, pending_review, agent_visible) WHERE scope='global';
CREATE INDEX IF NOT EXISTS idx_memory_stale ON agent_memory(active, agent_visible, view_count, last_viewed_at);
