-- 042: Skill 体系 —— 全局 skill 知识库 + (group, agent, skill) 绑定关系。
--
-- skill 本身不带可见性:它是全局能力资产。
-- 可见性靠 agent_skill_bindings 表达:某群的某 agent 持有某 skill。
-- agent 执行时按 (group, agent) 查绑定,注入极简指针 prompt。

CREATE TABLE IF NOT EXISTS agent_skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,                 -- 一句话描述(L1 索引/触发用)
  content       TEXT NOT NULL,                 -- markdown 正文
  category      TEXT,                          -- 可选分类,如 workflow/debug/convention
  source_type   TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','promoted')),
  source_ref    TEXT,                          -- promoted 时指向 memory_id
  created_by    TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  active        INTEGER NOT NULL DEFAULT 1,
  view_count    INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_skills_active ON agent_skills(active, name);
CREATE INDEX IF NOT EXISTS idx_skills_category ON agent_skills(active, category);

CREATE TABLE IF NOT EXISTS agent_skill_bindings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  skill_id    TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, agent_name, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_bindings_group_agent ON agent_skill_bindings(group_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_bindings_skill ON agent_skill_bindings(skill_id);
