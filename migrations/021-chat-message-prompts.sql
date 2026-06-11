-- 021: 单条 group 消息的"喂给 CLI 的 prompt 组合"持久化。
--
-- 用途:worker 在 `composePrompt()` 算出最终 prompt 后,把分层结果 + final 全文
-- 写到这里,keyed by group_messages.id。前端点击消息气泡时,直接读这行渲染
-- 分层组成(透明化),无需在 master / executor 端重算。
--
-- 为什么独立成表(不放在 group_messages 上做新列):
--   1. group_messages 是热读路径(每条消息都列),prompt 数据量远大于单条消息
--      原文,JOIN 出来会拖慢列表渲染。
--   2. 老消息(migration 之前的)没有这个数据,NULL 友好即可,不破坏老路径。
--   3. 后续如果要加 model_version / composed_by_worker_id 等元数据,扩展这一
--      张表不污染 group_messages。
--
-- 字段:
--   group_message_id: PK + FK → group_messages(id) ON DELETE CASCADE
--   layers:           JSON 数组,每项 { layer, content, source }
--   final:            拼好的完整 prompt(layers.map(c => c.content).join("\n"))
--   generated_at:     组合时间,ISO
--   prompt_version:   ROTOM_CLI_PROMPT 的版本号(rotomCliPrompt@YYYY-MM-DD),
--                     文本变化时 +1,前端能识别"老消息用的是旧版规则"
CREATE TABLE chat_message_prompts (
  group_message_id INTEGER PRIMARY KEY REFERENCES group_messages(id) ON DELETE CASCADE,
  layers           TEXT NOT NULL,
  final            TEXT NOT NULL,
  generated_at     TEXT NOT NULL,
  prompt_version   TEXT NOT NULL
);
CREATE INDEX idx_cmp_msg ON chat_message_prompts(group_message_id);
