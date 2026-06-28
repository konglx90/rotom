-- 035: scheduled_tasks 增加 handler 模式 —— 定时器到点跑硬编码逻辑,不是发消息也不是派 Issue。
--
-- 用途:ask-bridge 超时检查、issue 过期巡检、agent 离线告警等"到点跑一段代码"的场景。
-- handler_key 标识跑哪段代码(注册在 src/master/scheduler-handlers.ts 的 registry 里),
-- handler_payload 是 JSON 字符串,handler 自行解析。
--
-- 现有 mode='agent' / 'message' 不变;mode='handler' 新增。
-- 用 ALTER TABLE 加列(SQLite 不支持给现有 CHECK 加值,所以用触发器或应用层校验替代)。
-- mode 列的 CHECK 约束保留原样(只允许 agent/message),新增 mode='handler' 通过去掉
-- CHECK 约束实现 —— SQLite 不支持 ALTER TABLE DROP CONSTRAINT,所以重建表代价大。
-- 折中:新增 mode_handler 列代替扩展 mode 枚举,handler_key 非空即视为 handler 模式。
-- 这样老代码看 mode='agent' 但 handler_key 非空时跳过原 agent 逻辑,走 handler 分支。
--
-- 实际上更简单:直接加 handler_key / handler_payload 两列,所有现有 mode 值都保留。
-- scheduler.runOne 里:if (handler_key) 走 handler 分支,否则按 mode 走 agent/message。
ALTER TABLE scheduled_tasks ADD COLUMN handler_key TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN handler_payload TEXT;
