-- 018: Add archived_at column to groups table
-- NULL = active group, non-NULL timestamp = archived (read-only)
ALTER TABLE groups ADD COLUMN archived_at TEXT;
