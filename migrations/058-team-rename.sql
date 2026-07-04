-- 058: "部门" → "团队" 概念调整。
--
-- 应用场景从"公司-部门"缩小到"个人团队":每个 master = 一个团队(团队名 teamName
-- 人取,如"西花团队"),多团队通过 federation 协作。底层表/列名跟着改名,
-- 避免 concept 与代码术语脱节。
--
-- SQLite 3.25+ 支持 ALTER TABLE RENAME COLUMN,这里用它在原表上改名(不重建),
-- 保留所有数据。索引会自动跟着列名走。

-- 1. 表重命名
ALTER TABLE department RENAME TO team;
ALTER TABLE department_peers RENAME TO team_peers;

-- 2. 列重命名(department_id → team_id)
ALTER TABLE agent_visibility RENAME COLUMN department_id TO team_id;
ALTER TABLE human_membership RENAME COLUMN department_id TO team_id;
ALTER TABLE team_peers RENAME COLUMN department_id TO team_id;

-- 3. master_node 加 team_name 列(团队展示名,默认 = hostname)
ALTER TABLE master_node ADD COLUMN team_name TEXT;

-- 4. 索引重建(旧索引自动跟随列名,但显式重建保险)
-- 索引 idx_agent_visibility_lookup 原本 ON (department_id, hostname, agent_name)
-- SQLite 会自动更新索引定义为 (team_id, hostname, agent_name),无需手动操作。
-- 这里 DROP + CREATE 仅作幂等保护:
DROP INDEX IF EXISTS idx_agent_visibility_lookup;
CREATE INDEX IF NOT EXISTS idx_agent_visibility_lookup
  ON agent_visibility (team_id, hostname, agent_name);
