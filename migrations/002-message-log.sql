-- Message log for dashboard conversations view
CREATE TABLE IF NOT EXISTS message_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL,
  timestamp     TEXT DEFAULT (datetime('now')),
  from_name     TEXT NOT NULL,
  from_domain   TEXT,
  to_name       TEXT,
  to_domain     TEXT,
  route_type    TEXT,       -- exact / reply
  direction     TEXT,       -- send / reply
  payload       TEXT,       -- JSON: { message, skill?, ... }
  status        TEXT,       -- routed / queued / failed / replied
  latency_ms    INTEGER     -- time to reply (for replies)
);

CREATE INDEX IF NOT EXISTS idx_msglog_ts ON message_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_msglog_from ON message_log(from_name);
CREATE INDEX IF NOT EXISTS idx_msglog_to ON message_log(to_name);
CREATE INDEX IF NOT EXISTS idx_msglog_req ON message_log(request_id);
