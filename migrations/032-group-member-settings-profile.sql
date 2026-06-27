-- 032: 群级别 agent profile 覆盖 —— 给 group_member_settings 加 profile 列。
-- 存 JSON 字符串 { position?, bio?, category? }, dispatch-enrich 时 merge 到
-- agent 全局 profile 上(群级别字段优先), 用于"群内把某 agent 当作另一岗位"的场景。
-- NULL = 不覆盖, 沿用 agents.profile 全局值。
ALTER TABLE group_member_settings ADD COLUMN profile TEXT;
