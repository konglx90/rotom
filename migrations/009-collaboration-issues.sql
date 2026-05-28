-- 009: Collaboration issues — extend issues table for multi-agent collaboration

-- Add type column: 'task' (existing, default) or 'collaboration'
ALTER TABLE issues ADD COLUMN type TEXT NOT NULL DEFAULT 'task';

-- Collaboration-specific columns (NULL for task issues)
ALTER TABLE issues ADD COLUMN collaboration_goal TEXT;
ALTER TABLE issues ADD COLUMN max_rounds INTEGER;
ALTER TABLE issues ADD COLUMN current_round INTEGER DEFAULT 0;
ALTER TABLE issues ADD COLUMN participants TEXT DEFAULT '[]';
ALTER TABLE issues ADD COLUMN owner TEXT;
ALTER TABLE issues ADD COLUMN summary TEXT;

CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(type, status);

-- Track per-round contribution status for each participant
CREATE TABLE IF NOT EXISTS collaboration_round_tracker (
  issue_id        TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  round           INTEGER NOT NULL,
  agent_name      TEXT NOT NULL,
  has_contributed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, round, agent_name)
);
