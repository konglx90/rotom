-- 039: 给 agent_sessions 加累计 token 列。
-- 之前只有 cumulative_cost_usd 是累加的,input/output tokens 每次 upsert
-- 被覆盖成最近一 turn 的值。用户要求 token 数也累增,这样多 turn session
-- 的总消耗可见。
ALTER TABLE agent_sessions ADD COLUMN cumulative_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN cumulative_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN cumulative_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN cumulative_cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
