-- 031: AgentProfile 字段精简 —— 删除 tech_stack, 把 responsibilities 重命名为 bio。
-- agents.profile 列仍然是 TEXT JSON, 这里只做数据迁移: 清理历史 JSON 里的旧 key。
-- 新写入的 profile 由 parseAgentProfile 解析时只识别 position/bio/category, 旧 key 会被忽略,
-- 但为了让 sqlite 里存的 JSON 干净, 一次性 UPDATE 抹掉。
UPDATE agents
SET profile = json_set(
  json_remove(profile, '$.tech_stack', '$.responsibilities'),
  '$.bio', json_extract(profile, '$.responsibilities')
)
WHERE profile IS NOT NULL
  AND profile != ''
  AND json_valid(profile)
  AND (json_extract(profile, '$.responsibilities') IS NOT NULL
       OR json_extract(profile, '$.tech_stack') IS NOT NULL);
