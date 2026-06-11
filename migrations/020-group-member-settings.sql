-- 020: per-(group, agent) working_dir override.
-- Stores a custom cwd for a specific (group, agent) pair, applied at issue
-- assignment time and surfaced in the dashboard. Falls back to
-- groups.working_dir when unset for the pair.
CREATE TABLE group_member_settings (
  group_id    TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (group_id, agent_name)
);
CREATE INDEX idx_gms_agent ON group_member_settings(agent_name);
