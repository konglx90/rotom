-- 019: Add type and metadata columns to groups table (for e2ed integration)
ALTER TABLE groups ADD COLUMN type TEXT DEFAULT NULL;
ALTER TABLE groups ADD COLUMN metadata TEXT DEFAULT '{}';
