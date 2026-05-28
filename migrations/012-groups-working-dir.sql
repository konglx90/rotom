-- Add default working directory to groups. Used as default cwd for
-- chat replies in this group; falls back to agent's own workingDir.
ALTER TABLE groups ADD COLUMN working_dir TEXT;
