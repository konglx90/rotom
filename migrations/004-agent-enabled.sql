-- Add enabled column to agents table (default: enabled)
ALTER TABLE agents ADD COLUMN enabled INTEGER DEFAULT 1;
