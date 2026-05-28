-- 016: store agent plaintext token alongside the hash
-- Small-scale / personal use: surfacing the token in the dashboard avoids
-- forcing a refresh-token round-trip every time a user needs to copy it.
-- token_hash is kept for the existing auth path (no behaviour change there).
ALTER TABLE agents ADD COLUMN token TEXT;
