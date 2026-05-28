-- Issues: code tasks scoped to groups, executed by Agent Agents
CREATE TABLE IF NOT EXISTS issues (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',        -- open|in_progress|completed|failed|cancelled
  priority      TEXT NOT NULL DEFAULT 'medium',      -- low|medium|high|critical
  created_by    TEXT NOT NULL,                        -- agent_name who created the issue
  assigned_to   TEXT,                                 -- Agent agent_name
  working_dir   TEXT,                                 -- directory where the code agent operates
  result        TEXT,                                 -- final result/output text
  error_message TEXT,
  artifacts     TEXT DEFAULT '[]',                    -- JSON array of file paths produced
  started_at    TEXT,
  completed_at  TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_group ON issues(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

-- Issue events: timeline entries for issue progress tracking
CREATE TABLE IF NOT EXISTS issue_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,     -- created|assigned|started|progress|output|completed|failed|cancelled
  agent_name    TEXT NOT NULL,     -- who triggered this event
  content       TEXT NOT NULL DEFAULT '',
  metadata      TEXT DEFAULT '{}', -- JSON: { "file": "src/foo.ts", "bytes": 1234 }
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id, created_at);
