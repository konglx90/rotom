-- Add group_id to message_log so /dashboard/messages can filter by group.
ALTER TABLE message_log ADD COLUMN group_id TEXT;

CREATE INDEX IF NOT EXISTS idx_msglog_group ON message_log(group_id);
