-- 记录 issue 上一次执行结束时返回的 CLI session id,允许用户在 issue
-- completed/failed 后通过新的 input 续接同一会话(claude --resume / codex
-- thread/resume)。cli_tool 列用于校验续聊端跟首次执行端属于同一种 CLI。

ALTER TABLE issues ADD COLUMN session_id TEXT;
ALTER TABLE issues ADD COLUMN cli_tool TEXT;
