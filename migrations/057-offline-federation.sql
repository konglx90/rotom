-- 057: offline_messages 加跨 master 投递字段。
--
-- 目标 member 离线时,协调 master 把消息暂存在 offline_messages(扩展字段),
-- member 重连后批量 FedDeliver 重投。TTL 仍 24h(复用 OFFLINE_MESSAGE_TTL_HOURS)。

ALTER TABLE offline_messages ADD COLUMN target_hostname TEXT;
ALTER TABLE offline_messages ADD COLUMN source_master_id TEXT;
CREATE INDEX IF NOT EXISTS idx_offline_target_host
  ON offline_messages (target_hostname, target_agent);
