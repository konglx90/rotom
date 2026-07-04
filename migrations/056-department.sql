-- 056: Federation / 部门表族。
--
-- 一台机器 = 一个 master + 一组本地 agent(OPC)。多台机器通过「部门」联邦:
--   - coordination 角色的 master = 部门协调者,接受 member 接入、维护成员目录、
--     中转跨 master 消息(星型拓扑)。
--   - member 角色的 master = 接入者,主动 outbound 连协调,发布本地 agent 可见性。
--
-- 数据归属:agent 行 / 真人 / memory / issue 始终留在本地 master;协调 master
-- 只持有路由用的元信息(agent_visibility)。Phase 2 跨机消息全部经协调 master 中转。
--
-- 关键约束(与 plan 一致):
--   - 路由键用 masterId(8 字符 base36,持久化),不用 hostname / IP(后者会变)
--   - hostname 仅作 display,可改;department 内强制唯一便于人引用 alice@hostA
--   - 同一 department 同一 masterId 的 agent 不重复(PK 含 master_id)

CREATE TABLE IF NOT EXISTS department (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  -- 本机 master 在此部门里的角色
  my_role         TEXT NOT NULL CHECK(my_role IN ('coordination','member')),
  -- 协调 master 端点列表(逗号分隔 ws://host:port);member 用它知道往哪连
  coord_endpoints TEXT NOT NULL,
  joined_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 部门内 peer master 列表(协调侧维护路由,member 侧缓存最近一次 directory_sync)
CREATE TABLE IF NOT EXISTS department_peers (
  department_id   TEXT NOT NULL,
  master_id       TEXT NOT NULL,             -- 远端 master 的 masterId(8 字符 base36)
  hostname        TEXT NOT NULL,             -- 远端 hostname(display,可改)
  endpoint        TEXT,                      -- 远端 master ws(member↔member 直连预留,MVP 不用)
  role            TEXT NOT NULL,             -- coordination | member
  last_seen_at    TEXT,
  PRIMARY KEY (department_id, master_id)
);

-- 跨 master 可见的 agent 发布记录(协调侧权威,member 侧缓存)
-- 注意 PK 用 master_id 而非 hostname:hostname 只是 display,可改;masterId 永远稳定,
-- 即便用户改 hostname 或机器换网络,agent 归属都不会断。
CREATE TABLE IF NOT EXISTS agent_visibility (
  department_id   TEXT NOT NULL,
  master_id       TEXT NOT NULL,             -- 路由键:稳定
  agent_name      TEXT NOT NULL,
  hostname        TEXT NOT NULL,             -- 显示键:可改,仅作展示
  display_name    TEXT,
  is_human        INTEGER NOT NULL DEFAULT 0,
  online          INTEGER NOT NULL DEFAULT 0,
  last_heartbeat  TEXT,
  PRIMARY KEY (department_id, master_id, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_agent_visibility_lookup
  ON agent_visibility (department_id, hostname, agent_name);

-- 真人加入哪些部门(本机真人跨部门可见性)
CREATE TABLE IF NOT EXISTS human_membership (
  agent_id        TEXT NOT NULL,             -- 本机 agents.id(category='真人')
  department_id   TEXT NOT NULL,
  joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, department_id)
);
