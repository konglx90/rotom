-- Agent avatar support
-- Adds avatar_url column for custom avatars

ALTER TABLE agents ADD COLUMN avatar_url TEXT;
