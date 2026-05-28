-- Groups: named rooms for multi-agent conversations
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  joined_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
