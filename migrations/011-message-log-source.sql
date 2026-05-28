-- Add source column to message_log to distinguish CLI vs WS vs API messages
ALTER TABLE message_log ADD COLUMN source TEXT;
