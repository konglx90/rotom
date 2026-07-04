-- 055: agents 表 hostname 复合键索引(为 Phase 2 federation 准备)。
--
-- 新模型下,agent 标识有两层:
--   - 路由键 (masterId, agent_name) —— master_node.id + agents.name,永远稳定
--   - 显示键 (hostname, agent_name) —— agents.hostname + agents.name,给人看
--
-- agents.name 本身已是 UNIQUE(001-init.sql),所以这个 (hostname, name) 复合 UNIQUE
-- 索引在 Phase 1 是结构性 no-op —— 但它存在的意义是:
--   1. 文档化新的复合键语义(Phase 2 计划解除 agents.name 的 UNIQUE 约束,
--      届时复合 UNIQUE 索引继续生效,保证本机内 (hostname, name) 不冲突)
--   2. 给按 hostname 反查的查询(例如 findVisibleAgentByName)提供索引
--
-- hostname 回填不在 migration 里做 —— 此时 master_node 表存在但还没有身份行
-- (身份行由 OPC bootstrap 在 TS 层首次启动时写入,因为要生成短 ID 和做 IP 校验)。
-- 回填逻辑放在 OPC bootstrap:
--   UPDATE agents SET hostname = <本机 hostname> WHERE hostname IS NULL

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_host_name
  ON agents (hostname, name);

CREATE INDEX IF NOT EXISTS idx_agents_hostname
  ON agents (hostname);
