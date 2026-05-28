-- Digital Employee Mesh — Initial schema
-- 7 tables: agents, domains, cross_domain_rules, offline_messages, audit_log, invites, config

-- Business domains
CREATE TABLE IF NOT EXISTS domains (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Cross-domain communication rules
CREATE TABLE IF NOT EXISTS cross_domain_rules (
  from_domain TEXT NOT NULL,
  to_domain   TEXT NOT NULL,
  PRIMARY KEY (from_domain, to_domain)
);

-- Agent registry
CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  description         TEXT,
  domain              TEXT,
  owner               TEXT,
  capabilities        TEXT DEFAULT '[]',
  status              TEXT DEFAULT 'offline',
  instance_id         TEXT,
  hostname            TEXT,
  platform            TEXT,
  version             TEXT,
  last_heartbeat      TEXT,
  connected_at        TEXT,
  registered_at       TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  token_hash          TEXT
);

-- Offline messages (delivered on reconnect)
CREATE TABLE IF NOT EXISTS offline_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent  TEXT    NOT NULL,
  from_name     TEXT    NOT NULL,
  from_domain   TEXT,
  payload       TEXT    NOT NULL,
  route_type    TEXT,
  created_at    TEXT    DEFAULT (datetime('now')),
  expires_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_offline_target ON offline_messages(target_agent);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT DEFAULT (datetime('now')),
  from_name       TEXT,
  from_domain     TEXT,
  to_name         TEXT,
  to_domain       TEXT,
  route_type      TEXT,
  route_score     REAL,
  result          TEXT,
  message_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);

-- Invite codes (v2.1)
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  domain     TEXT,
  created_by TEXT,
  used_by    TEXT,
  expires_at TEXT,
  used_at    TEXT
);

-- System config (jwt_secret, etc.)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
