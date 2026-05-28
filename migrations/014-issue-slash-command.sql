-- 在 issue 上记录创建时声明的 slash command（如 /plan）。
-- 由 master 端基于 title 前缀解析，并校验白名单（src/shared/slash-commands.ts）。
-- worker 据此向底层 CLI 注入对应执行模式：
--   /plan + claude → --permission-mode plan
--   /plan + codex  → thread/start 注入 developerInstructions

ALTER TABLE issues ADD COLUMN slash_command TEXT;
