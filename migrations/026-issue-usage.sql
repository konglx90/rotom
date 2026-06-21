-- 记录 issue 最近一次执行结束时的 token usage / 模型名,供 Dashboard
-- 在 Issue 详情头部和 Debug Sessions 列表展示。usage 存 JSON 字符串,
-- 形态见 src/executor/cli-executor.ts 的 TokenUsage interface。
-- 三种 backend(claude / codex / hermes)各自从 result / turn/completed /
-- usage_update 事件抽取并经 worker.sessionMeta 透传过来。

ALTER TABLE issues ADD COLUMN usage TEXT;
ALTER TABLE issues ADD COLUMN model TEXT;
