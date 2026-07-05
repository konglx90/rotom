-- Consolidated initial schema -- replaces migrations 001--059.
-- Generated from the final state after all incremental migrations.
-- For fresh installs only; no ALTER TABLE / data migration needed.

-- ====================================================================
-- Core: agents, domains, config
-- ====================================================================

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

-- Agent registry (final columns: 001 + 004 + 007 + 016 + 030)
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
  token_hash          TEXT,
  enabled             INTEGER DEFAULT 1,
  profile             TEXT,
  token               TEXT,
  avatar_url          TEXT
);

-- System config (jwt_secret, etc.)
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ====================================================================
-- Auditing & invites
-- ====================================================================

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

-- Invite codes
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  domain     TEXT,
  created_by TEXT,
  used_by    TEXT,
  expires_at TEXT,
  used_at    TEXT
);

-- ====================================================================
-- Message log (002 + 010 + 011)
-- ====================================================================

CREATE TABLE IF NOT EXISTS message_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL,
  timestamp     TEXT DEFAULT (datetime('now')),
  from_name     TEXT NOT NULL,
  from_domain   TEXT,
  to_name       TEXT,
  to_domain     TEXT,
  route_type    TEXT,
  direction     TEXT,
  payload       TEXT,
  status        TEXT,
  latency_ms    INTEGER,
  group_id      TEXT,
  source        TEXT
);

CREATE INDEX IF NOT EXISTS idx_msglog_ts ON message_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_msglog_from ON message_log(from_name);
CREATE INDEX IF NOT EXISTS idx_msglog_to ON message_log(to_name);
CREATE INDEX IF NOT EXISTS idx_msglog_req ON message_log(request_id);
CREATE INDEX IF NOT EXISTS idx_msglog_group ON message_log(group_id);

-- ====================================================================
-- Offline messages (001 + 057 + 059)
-- ====================================================================

CREATE TABLE IF NOT EXISTS offline_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent      TEXT NOT NULL,
  from_name         TEXT NOT NULL,
  from_domain       TEXT,
  payload           TEXT NOT NULL,
  route_type        TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  expires_at        TEXT,
  target_hostname   TEXT,
  source_master_id  TEXT,
  target_master_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_offline_target ON offline_messages(target_agent);
CREATE INDEX IF NOT EXISTS idx_offline_target_host ON offline_messages(target_hostname, target_agent);
CREATE INDEX IF NOT EXISTS idx_offline_target_master ON offline_messages(target_master_id) WHERE target_master_id IS NOT NULL;

-- ====================================================================
-- Groups (005 + 012 + 017 + 018 + 019 + 033 + 050 + 051 + 052)
-- ====================================================================

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  created_by          TEXT,
  created_at          TEXT DEFAULT (datetime('now')),
  working_dir         TEXT,
  pinned_at           TEXT,
  archived_at         TEXT,
  type                TEXT DEFAULT NULL,
  metadata            TEXT DEFAULT '{}',
  guidance_prompt     TEXT,
  starred_at          TEXT,
  repo_url            TEXT,
  repo_default_branch TEXT,
  extra_repos         TEXT,
  worktree_mode       TEXT,
  last_activity_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_groups_pair_activity
  ON groups(type, last_activity_at)
  WHERE type = 'a2a_direct' AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS group_members (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  joined_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);

-- ====================================================================
-- Group messages (006 + 022)
-- ====================================================================

CREATE TABLE IF NOT EXISTS group_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender        TEXT NOT NULL,
  content       TEXT NOT NULL,
  mentions      TEXT DEFAULT '[]',
  created_at    TEXT DEFAULT (datetime('now')),
  cancelled_at  TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);

-- ====================================================================
-- Group member settings (020 + 032)
-- ====================================================================

CREATE TABLE IF NOT EXISTS group_member_settings (
  group_id    TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  profile     TEXT,
  PRIMARY KEY (group_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_gms_agent ON group_member_settings(agent_name);

-- ====================================================================
-- Chat message prompts (021)
-- ====================================================================

CREATE TABLE IF NOT EXISTS chat_message_prompts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL,
  full_prompt     TEXT NOT NULL,
  system_prompt   TEXT NOT NULL,
  user_prompt     TEXT NOT NULL,
  prompt_tokens   INTEGER,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(group_message_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_cmp_msg ON chat_message_prompts(group_message_id);

-- ====================================================================
-- Issues (008 + 009 + 013 + 014 + 015 + 026 + 028 + 051)
-- ====================================================================

CREATE TABLE IF NOT EXISTS issues (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open',
  priority        TEXT NOT NULL DEFAULT 'medium',
  created_by      TEXT NOT NULL,
  assigned_to     TEXT,
  working_dir     TEXT,
  result          TEXT,
  error_message   TEXT,
  artifacts       TEXT DEFAULT '[]',
  type            TEXT NOT NULL DEFAULT 'task',
  collaboration_goal TEXT,
  max_rounds      INTEGER,
  current_round   INTEGER DEFAULT 0,
  participants    TEXT DEFAULT '[]',
  owner           TEXT,
  summary         TEXT,
  session_id      TEXT,
  cli_tool        TEXT,
  slash_command   TEXT,
  approval_policy TEXT NOT NULL DEFAULT 'r_allow',
  usage           TEXT,
  model           TEXT,
  latest_todos_json TEXT DEFAULT NULL,
  repo_url        TEXT,
  repo_branch     TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_group ON issues(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(type, status);

-- Issue events (008 + 023)
CREATE TABLE IF NOT EXISTS issue_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  metadata      TEXT DEFAULT '{}',
  reply_to_id   INTEGER REFERENCES issue_events(id),
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id, created_at);

-- ====================================================================
-- Scheduled tasks (027 + 035)
-- ====================================================================

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  group_id        TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'agent' CHECK (mode IN ('agent','message')),
  agent_name      TEXT,
  schedule_kind   TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_kind IN ('once','interval')),
  interval_sec    INTEGER,
  run_at          INTEGER,
  prompt          TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  next_run_at     INTEGER NOT NULL,
  last_run_at     INTEGER,
  last_status     TEXT,
  last_error      TEXT,
  last_issue_id   TEXT,
  repeat_times    INTEGER,
  repeat_count    INTEGER NOT NULL DEFAULT 0,
  handler_key     TEXT,
  handler_payload TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);

-- ====================================================================
-- Ask bridges (034)
-- ====================================================================

CREATE TABLE IF NOT EXISTS ask_bridges (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  asker           TEXT NOT NULL,
  target          TEXT NOT NULL,
  question_msg_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  escalate_to     TEXT,
  timeout_ms      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reply_msg_id    INTEGER REFERENCES group_messages(id) ON DELETE SET NULL,
  resolved_at     INTEGER,
  issue_id        TEXT REFERENCES issues(id) ON DELETE SET NULL,
  mode            TEXT NOT NULL DEFAULT 'async',
  CHECK (status IN ('pending','answered','timed_out','cancelled')),
  CHECK (mode IN ('sync','async'))
);

CREATE INDEX IF NOT EXISTS idx_ask_bridges_pending ON ask_bridges(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ask_bridges_lookup ON ask_bridges(group_id, target, status);
CREATE INDEX IF NOT EXISTS idx_ask_bridges_asker ON ask_bridges(asker, status);

-- ====================================================================
-- Guidance templates (036)
-- ====================================================================

CREATE TABLE IF NOT EXISTS guidance_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  prompt_text     TEXT NOT NULL,
  schedule_config TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_default      INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ====================================================================
-- Schedule patterns (037)
-- ====================================================================

CREATE TABLE IF NOT EXISTS schedule_patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  schedule_config TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_default      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ====================================================================
-- Agent sessions (038 + 039)
-- ====================================================================

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id                  TEXT NOT NULL,
  agent_name                TEXT NOT NULL,
  cli_tool                  TEXT NOT NULL,
  session_id                TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at              TEXT NOT NULL DEFAULT (datetime('now')),
  input_tokens              INTEGER,
  output_tokens             INTEGER,
  cache_read_tokens         INTEGER,
  cache_creation_tokens     INTEGER,
  total_cost_usd            REAL,
  model                     TEXT,
  cumulative_cost_usd       REAL NOT NULL DEFAULT 0,
  invalidated_at            TEXT NULL,
  cumulative_input_tokens         INTEGER NOT NULL DEFAULT 0,
  cumulative_output_tokens        INTEGER NOT NULL DEFAULT 0,
  cumulative_cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cumulative_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  UNIQUE(cli_tool, group_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_group ON agent_sessions(group_id, last_used_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_name, cli_tool, invalidated_at);

-- ====================================================================
-- Agent memory (024 -> 040 -> 041)
-- ====================================================================

CREATE TABLE IF NOT EXISTS agent_memory (
  id              TEXT PRIMARY KEY,
  group_id        TEXT REFERENCES groups(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL DEFAULT 'group' CHECK (scope IN ('group','global')),
  category        TEXT NOT NULL DEFAULT 'note' CHECK (category IN ('fact','decision','convention','pitfall','todo','playbook','note')),
  source_type     TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','issue_summary')),
  source_ref      TEXT,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  summary         TEXT,
  tags            TEXT DEFAULT '[]',
  visibility      TEXT NOT NULL DEFAULT 'group' CHECK (visibility IN ('private','group','global')),
  agent_visible   INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  expires_at      TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  pending_review  INTEGER NOT NULL DEFAULT 0,
  injected_count  INTEGER NOT NULL DEFAULT 0,
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_scope_group ON agent_memory(scope, group_id, agent_visible, active, pending_review, category);
CREATE INDEX IF NOT EXISTS idx_memory_key ON agent_memory(scope, group_id, key, active, agent_visible);
CREATE INDEX IF NOT EXISTS idx_memory_global ON agent_memory(scope, active, pending_review, agent_visible) WHERE scope='global';
CREATE INDEX IF NOT EXISTS idx_memory_stale ON agent_memory(active, agent_visible, view_count, last_viewed_at);
CREATE INDEX IF NOT EXISTS idx_notes_group ON agent_memory(group_id, created_at);

-- ====================================================================
-- Skills (042)
-- ====================================================================

CREATE TABLE IF NOT EXISTS agent_skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT,
  source_type   TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual','promoted')),
  source_ref    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  active        INTEGER NOT NULL DEFAULT 1,
  view_count    INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_skills_active ON agent_skills(active, name);
CREATE INDEX IF NOT EXISTS idx_skills_category ON agent_skills(active, category);

CREATE TABLE IF NOT EXISTS agent_skill_bindings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  agent_name  TEXT NOT NULL,
  skill_id    TEXT NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, agent_name, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_bindings_group_agent ON agent_skill_bindings(group_id, agent_name);
CREATE INDEX IF NOT EXISTS idx_bindings_skill ON agent_skill_bindings(skill_id);

-- ====================================================================
-- Issue patrol (043)
-- ====================================================================

CREATE TABLE IF NOT EXISTS issue_patrol_runs (
  run_id              TEXT PRIMARY KEY,
  patrol_group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  patrol_issue_id     TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  in_progress_count   INTEGER NOT NULL DEFAULT 0,
  candidates_scanned  INTEGER NOT NULL DEFAULT 0,
  candidates_ready    INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL,
  note                TEXT
);

CREATE INDEX IF NOT EXISTS idx_patrol_runs_group ON issue_patrol_runs(patrol_group_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_patrol_runs_patrol_issue ON issue_patrol_runs(patrol_issue_id);

CREATE TABLE IF NOT EXISTS issue_patrol_logs (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES issue_patrol_runs(run_id) ON DELETE CASCADE,
  patrol_group_id     TEXT NOT NULL,
  issue_id            TEXT,
  candidate_group_id  TEXT,
  verdict             TEXT NOT NULL,
  rule_matched        TEXT,
  rationale           TEXT,
  raw                 TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patrol_logs_run ON issue_patrol_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_patrol_group ON issue_patrol_logs(patrol_group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_verdict ON issue_patrol_logs(verdict);
CREATE INDEX IF NOT EXISTS idx_patrol_logs_candidate_group ON issue_patrol_logs(candidate_group_id);

-- ====================================================================
-- Links (053)
-- ====================================================================

CREATE TABLE IF NOT EXISTS links (
  id            TEXT PRIMARY KEY,
  url_norm      TEXT NOT NULL UNIQUE,
  url_raw       TEXT NOT NULL,
  title         TEXT,
  category      TEXT,
  summary       TEXT,
  host          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_category ON links(category);
CREATE INDEX IF NOT EXISTS idx_links_host ON links(host);
CREATE INDEX IF NOT EXISTS idx_links_unclassified ON links(last_seen_at) WHERE category IS NULL;
CREATE INDEX IF NOT EXISTS idx_links_updated ON links(updated_at DESC);

CREATE TABLE IF NOT EXISTS link_tags (
  link_id  TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (link_id, tag)
);

CREATE TABLE IF NOT EXISTS link_occurrences (
  id                TEXT PRIMARY KEY,
  link_id           TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL,
  source_id         TEXT,
  source_group_id   TEXT,
  source_sender     TEXT,
  context_snippet   TEXT,
  occurred_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_occurrences_link ON link_occurrences(link_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_group ON link_occurrences(source_group_id);
CREATE INDEX IF NOT EXISTS idx_occurrences_occurred ON link_occurrences(occurred_at DESC);

CREATE TABLE IF NOT EXISTS link_source_groups (
  link_id   TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  group_id  TEXT NOT NULL,
  PRIMARY KEY (link_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_link_source_groups_group ON link_source_groups(group_id);

CREATE TABLE IF NOT EXISTS link_patrol_runs (
  run_id                  TEXT PRIMARY KEY,
  patrol_group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  patrol_issue_id         TEXT,
  started_at              TEXT NOT NULL,
  finished_at             TEXT,
  candidates_scanned      INTEGER NOT NULL DEFAULT 0,
  candidates_classified   INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL,
  note                    TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_patrol_runs_group ON link_patrol_runs(patrol_group_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_link_patrol_runs_issue ON link_patrol_runs(patrol_issue_id);

CREATE TABLE IF NOT EXISTS link_patrol_logs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES link_patrol_runs(run_id) ON DELETE CASCADE,
  link_id         TEXT,
  category        TEXT NOT NULL,
  tags            TEXT,
  title           TEXT,
  rationale       TEXT,
  raw             TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_patrol_logs_run ON link_patrol_logs(run_id);

-- ====================================================================
-- Master node identity (054 + 058)
-- ====================================================================

CREATE TABLE IF NOT EXISTS master_node (
  id                 TEXT PRIMARY KEY,
  hostname           TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'standalone',
  display_name       TEXT,
  endpoint           TEXT,
  federation_enabled INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  team_name          TEXT
);

-- ====================================================================
-- Federation: team (056 -> 058 renamed department->team)
-- ====================================================================

CREATE TABLE IF NOT EXISTS team (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  my_role         TEXT NOT NULL CHECK(my_role IN ('coordination','member')),
  coord_endpoints TEXT NOT NULL,
  joined_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_peers (
  team_id      TEXT NOT NULL,
  master_id    TEXT NOT NULL,
  hostname     TEXT NOT NULL,
  endpoint     TEXT,
  role         TEXT NOT NULL,
  last_seen_at TEXT,
  PRIMARY KEY (team_id, master_id)
);

CREATE TABLE IF NOT EXISTS agent_visibility (
  team_id       TEXT NOT NULL,
  master_id     TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  display_name  TEXT,
  is_human      INTEGER NOT NULL DEFAULT 0,
  online        INTEGER NOT NULL DEFAULT 0,
  last_heartbeat TEXT,
  PRIMARY KEY (team_id, master_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_visibility_lookup
  ON agent_visibility (team_id, hostname, agent_name);

CREATE TABLE IF NOT EXISTS human_membership (
  agent_id      TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, team_id)
);

-- ====================================================================
-- Indexes from 055 (agent composite key)
-- ====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_host_name
  ON agents (hostname, name);

CREATE INDEX IF NOT EXISTS idx_agents_hostname
  ON agents (hostname);


-- ====================================================================
-- Seed data
-- ====================================================================

-- Guidance templates (from 036)
INSERT INTO guidance_templates (name, description, prompt_text, schedule_config, sort_order, is_default, created_at, updated_at) VALUES
('群内讨论方案设计',
 '不创建 issue，群内成员讨论完成方案设计',
 '本群通过群内成员讨论完成方案设计。不需要创建 issue 执行任务，所有方案讨论在群内进行。提问对方时用 #reply @对方。',
 NULL,
 1, 1, strftime('%%s','now')*1000, strftime('%%s','now')*1000),
('群内讨论 + 老师定时检查',
 '群内讨论完成，老师 agent 每分钟检查一次讨论结果，8 分钟后结束',
 '本群通过群内成员讨论完成方案。不需要创建 issue。老师 {{teacher}} 每分钟会检查一次讨论结果，对 {{student}} 的回答给出赞同/反对/补充意见。8 分钟后结束。',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":60,"repeat_times":8,"prompt":"检查群内最近的讨论，作为老师 {{teacher}} 对学生 {{student}} 的回答给出赞同/反对/补充意见。"}'),
 2, 1, strftime('%%s','now')*1000, strftime('%%s','now')*1000),
('老师提问-学生回答-老师回应',
 '{{teacher}} 提问，{{student}} 回答或提意见，{{teacher}} 再赞同/反对/补充',
 '{{teacher}} 作为老师提问，{{student}} 作为学生回答或提出意见，{{teacher}} 再表示赞同/反对/补充。讨论话题：{{topic}}。提问对方时用 #reply @对方。',
 NULL,
 3, 1, strftime('%%s','now')*1000, strftime('%%s','now')*1000);

-- Schedule patterns (from 037)
INSERT INTO schedule_patterns (name, description, schedule_config, sort_order, is_default, created_at, updated_at) VALUES
('每 60 秒轮询检查',
 'interval 模式,固定 60 秒触发一次,适合高频巡检类任务',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":60,"repeat_times":10,"prompt":"检查最新进展并给出反馈。"}'),
 1, 1, strftime('%%s','now')*1000, strftime('%%s','now')*1000),
('一次性定时提醒',
 'once 模式,在指定时间点触发一次后结束',
 json('{"mode":"message","schedule_kind":"once","run_at":0,"prompt":"到点了,该开始了。"}'),
 2, 1, strftime('%%s','now')*1000, strftime('%%s','now')*1000),
('每日固定周期播报',
 'interval 模式,86400 秒(一天)周期触发,适合每日晨会/日报类任务',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":86400,"repeat_times":null,"prompt":"生成今日总结并发到群里。"}'),
 3, 1, strftime('%%s','now')*1000, strftime('%%s','now')*1000);

-- Issue patrol rules skill seed (from 043, fixed ID)
INSERT OR IGNORE INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
VALUES (
  'sk_issue_patrol_rules_seed',
  'issue-patrol-rules',
  'Issue 巡检规则:判断一个 open issue 是否可以直接认领开工',
  '# Issue 巡检规则

巡检员的任务:对每个候选 issue 给出 verdict(ready / not_ready / uncertain)和理由,
**不要**认领、分配、或操作任何候选 issue,只输出判断。

## 可直接认领 (verdict=ready) 的信号

满足以下任一即为 ready:

- **小需求**:改动范围 <= 2 个文件,不动 DB schema、不动 CI/部署配置
  - 信号:title 含「小改」「修」「补」「tweak」等,或 description 明确范围
- **出方案 / 调研**:产物是文档/markdown,不改业务代码
  - 信号:slash_command 含 /plan /research /investigate,title 含「调研」「方案」「设计」「评估」
- **纯文档 / 单测补充**:artifacts 预期是 .md 或 .test.ts,不动实现
  - 信号:title 含「文档」「补充测试」「补单测」

## 不建议认领 (verdict=not_ready) 的信号

满足以下任一即为 not_ready:

- **重构 / 跨模块改动**:影响 3+ 文件,或横跨多个领域模块
  - 信号:title 含「重构」「refactor」「迁移」「改造」
- **改 schema / 部署**:动 migrations、改 CI、动部署脚本
  - 信号:title 含「schema」「migration」「CI」「部署」「release」
- **依赖外部决策**:需要真人拍板、或依赖未完成的协作
  - 信号:description 里出现「等确认」「待拍板」「需要 X 先完成」

## 不确定 (verdict=uncertain)

信息不足、或规则都没命中时标 uncertain,rationale 说明缺什么信息。

## 输出格式

patrol issue 的 result 字段必须是 JSON 数组,每条:
',
  'workflow',
  'manual',
  NULL,
  'system:patrol-bootstrap',
  datetime('now'),
  datetime('now'),
  1,
  0,
  NULL
);

-- Link patrol rules skill seed (from 053, fixed ID)
INSERT OR IGNORE INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
VALUES (
  'sk_link_patrol_rules_seed',
  'link-patrol-rules',
  '链接智能分类巡检规则:对候选链接给出 category/tags/title',
  '# 链接智能分类规则

你的任务:对每条候选链接给出 category + tags[] + title + rationale。
**不要**直接修改 links 表(只输出 JSON,系统会落库)。

## 分类目(category 单选,从下列选一个)

- reference     : 文档/规范/Wiki/参考资料
- code          : GitHub/GitLab/代码仓库 PR/Issue
- tool          : 工具/服务/产品官网
- article       : 博客/技术文章/教程
- paper         : 论文/研究报告
- discussion    : 论坛/HN/Reddit/Stack Overflow 讨论
- issue-tracker : 内部 Issue / 工单系统链接
- media         : 图片/视频/演示
- other         : 兜底

## Tags(自由字符串数组,推断规则)

按 host + path 关键词推断,例:
- react 官方文档 -> ["react", "hooks"]
- anthropic SDK 仓库 -> ["anthropic", "claude-api", "sdk"]
- pnpm monorepo 文档 -> ["pnpm", "monorepo"]

## Title 提取规则

- 优先用 context snippet 里 markdown [text](url) 的 text
- 否则用 url path 末段 + host(例:react.dev/hooks -> hooks . react.dev)

## 输出格式

issue result 字段必须是 JSON 数组(用 markdown code block 包裹):

',
  'patrol',
  'manual',
  NULL,
  'system:link-patrol-bootstrap',
  datetime('now'),
  datetime('now'),
  1,
  0,
  NULL
);

-- ====================================================================
-- Seed data
-- ====================================================================

-- Guidance templates (from 036)
INSERT INTO guidance_templates (name, description, prompt_text, schedule_config, sort_order, is_default, created_at, updated_at) VALUES
('群内讨论方案设计',
 '不创建 issue，群内成员讨论完成方案设计',
 '本群通过群内成员讨论完成方案设计。不需要创建 issue 执行任务，所有方案讨论在群内进行。提问对方时用 #reply @对方。',
 NULL,
 1, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('群内讨论 + 老师定时检查',
 '群内讨论完成，老师 agent 每分钟检查一次讨论结果，8 分钟后结束',
 '本群通过群内成员讨论完成方案。不需要创建 issue。老师 {{teacher}} 每分钟会检查一次讨论结果，对 {{student}} 的回答给出赞同/反对/补充意见。8 分钟后结束。',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":60,"repeat_times":8,"prompt":"检查群内最近的讨论，作为老师 {{teacher}} 对学生 {{student}} 的回答给出赞同/反对/补充意见。"}'),
 2, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('老师提问-学生回答-老师回应',
 '{{teacher}} 提问，{{student}} 回答或提意见，{{teacher}} 再赞同/反对/补充',
 '{{teacher}} 作为老师提问，{{student}} 作为学生回答或提出意见，{{teacher}} 再表示赞同/反对/补充。讨论话题：{{topic}}。提问对方时用 #reply @对方。',
 NULL,
 3, 1, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- Schedule patterns (from 037)
INSERT INTO schedule_patterns (name, description, schedule_config, sort_order, is_default, created_at, updated_at) VALUES
('每 60 秒轮询检查',
 'interval 模式,固定 60 秒触发一次,适合高频巡检类任务',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":60,"repeat_times":10,"prompt":"检查最新进展并给出反馈。"}'),
 1, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('一次性定时提醒',
 'once 模式,在指定时间点触发一次后结束',
 json('{"mode":"message","schedule_kind":"once","run_at":0,"prompt":"到点了,该开始了。"}'),
 2, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('每日固定周期播报',
 'interval 模式,86400 秒(一天)周期触发,适合每日晨会/日报类任务',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":86400,"repeat_times":null,"prompt":"生成今日总结并发到群里。"}'),
 3, 1, strftime('%s','now')*1000, strftime('%s','now')*1000);

-- Issue patrol rules skill seed (from 043)
INSERT OR IGNORE INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
VALUES (
  'sk_issue_patrol_rules_seed',
  'issue-patrol-rules',
  'Issue 巡检规则:判断一个 open issue 是否可以直接认领开工',
  '# Issue 巡检规则

巡检员的任务:对每个候选 issue 给出 verdict(ready / not_ready / uncertain)和理由,
**不要**认领、分配、或操作任何候选 issue,只输出判断。

## 可直接认领 (verdict=ready) 的信号

满足以下任一即为 ready:

- **小需求**:改动范围 <= 2 个文件,不动 DB schema、不动 CI/部署配置
  - 信号:title 含「小改」「修」「补」「tweak」等,或 description 明确范围
- **出方案 / 调研**:产物是文档/markdown,不改业务代码
  - 信号:slash_command 含 /plan /research /investigate,title 含「调研」「方案」「设计」「评估」
- **纯文档 / 单测补充**:artifacts 预期是 .md 或 .test.ts,不动实现
  - 信号:title 含「文档」「补充测试」「补单测」

## 不建议认领 (verdict=not_ready) 的信号

满足以下任一即为 not_ready:

- **重构 / 跨模块改动**:影响 3+ 文件,或横跨多个领域模块
  - 信号:title 含「重构」「refactor」「迁移」「改造」
- **改 schema / 部署**:动 migrations、改 CI、动部署脚本
  - 信号:title 含「schema」「migration」「CI」「部署」「release」
- **依赖外部决策**:需要真人拍板、或依赖未完成的协作
  - 信号:description 里出现「等确认」「待拍板」「需要 X 先完成」

## 不确定 (verdict=uncertain)

信息不足、或规则都没命中时标 uncertain,rationale 说明缺什么信息。

## 输出格式

patrol issue 的 result 字段必须是 JSON 数组,每条:
```
{
  "issue_id": "<候选 id>",
  "verdict": "ready" | "not_ready" | "uncertain",
  "rule_matched": "<命中的规则名,如 small-requirement / heavy-refactor / 等>",
  "rationale": "<一句话理由>"
}
```',
  'workflow',
  'manual',
  NULL,
  'system:patrol-bootstrap',
  datetime('now'),
  datetime('now'),
  1,
  0,
  NULL
);

-- Link patrol rules skill seed (from 053)
INSERT OR IGNORE INTO agent_skills (id, name, description, content, category, source_type, source_ref, created_by, created_at, updated_at, active, view_count, last_viewed_at)
VALUES (
  'sk_link_patrol_rules_seed',
  'link-patrol-rules',
  '链接智能分类巡检规则:对候选链接给出 category/tags/title',
  '# 链接智能分类规则

你的任务:对每条候选链接给出 category + tags[] + title + rationale。
**不要**直接修改 links 表(只输出 JSON,系统会落库)。

## 分类目(category 单选,从下列选一个)

- reference     : 文档/规范/Wiki/参考资料
- code          : GitHub/GitLab/代码仓库 PR/Issue
- tool          : 工具/服务/产品官网
- article       : 博客/技术文章/教程
- paper          : 论文/研究报告
- discussion    : 论坛/HN/Reddit/Stack Overflow 讨论
- issue-tracker : 内部 Issue / 工单系统链接
- media         : 图片/视频/演示
- other         : 兜底

## Tags(自由字符串数组,推断规则)

按 host + path 关键词推断,例:
- react 官方文档 -> ["react", "hooks"]
- anthropic SDK 仓库 -> ["anthropic", "claude-api", "sdk"]
- pnpm monorepo 文档 -> ["pnpm", "monorepo"]

## Title 提取规则

- 优先用 context snippet 里 markdown [text](url) 的 text
- 否则用 url path 末段 + host(例:react.dev/hooks -> hooks . react.dev)

## 输出格式

issue result 字段必须是 JSON 数组(用 markdown code block 包裹):

```json
[
  {
    "link_id": "<uuid>",
    "category": "reference",
    "tags": ["react", "hooks"],
    "title": "React Hooks 官方文档",
    "rationale": "react.dev 是官方域名,路径 /hooks 属参考资料"
  }
]
```',
  'patrol',
  'manual',
  NULL,
  'system:link-patrol-bootstrap',
  datetime('now'),
  datetime('now'),
  1,
  0,
  NULL
);
