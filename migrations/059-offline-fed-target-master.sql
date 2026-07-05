-- 059: offline_messages 加 target_master_id 列。
--
-- 057 加的 target_hostname 是 display 列(hostname 可改,member 重连后可能变),
-- 按它查重投会丢消息。Phase 3 加 target_master_id(masterId 永远稳定)做主键查,
-- target_hostname 退化为 display 备份。
--
-- 协调 master 用 (target_master_id, source_master_id IS NOT NULL) 区分跨 master 暂存
-- 与本地 agent 离线队列(target_master_id IS NULL)。

ALTER TABLE offline_messages ADD COLUMN target_master_id TEXT;
CREATE INDEX IF NOT EXISTS idx_offline_target_master
  ON offline_messages (target_master_id) WHERE target_master_id IS NOT NULL;
