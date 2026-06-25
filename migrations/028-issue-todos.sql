-- Issue latest_todos_json:最新一次 TodoWrite 工具调用的 todos 数组快照。
-- 由 worker 收到 Claude Code 的 TodoWrite tool_use 后,通过 issue_todos_update
-- WS 消息推送,master 落到这一列。dashboard Issue 详情页常驻面板直接读它,
-- 不需要扫整个 issue_events 表找最新 todos 事件。
-- 字段:JSON 字符串,形如 [{"content":"...","status":"pending|in_progress|completed","activeForm":"..."}]
ALTER TABLE issues ADD COLUMN latest_todos_json TEXT DEFAULT NULL;
