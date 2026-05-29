-- Per-group pin to top. NULL means not pinned; setting a timestamp ranks the
-- group above unpinned ones in the sidebar list. Storing the moment of pin
-- (not a boolean) lets us stable-sort by "most recently pinned first" if a
-- user pins several groups in a row.
ALTER TABLE groups ADD COLUMN pinned_at TEXT;
