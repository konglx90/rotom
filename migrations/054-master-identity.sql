-- 054: Master 节点身份表。
--
-- 本机 master 的 masterId / hostname / role 持久化(单行表)。
-- masterId 是 8 字符 base36 小写短 ID,首次启动由 OPC bootstrap 生成、写入此表,
-- 之后永远稳定(机器换网络、改 IP、改 os.hostname 都不影响)。
--
-- 此 migration 只建表结构,不 INSERT 身份行 —— 数据由 OPC bootstrap 在 TS 层写入,
-- 因为 masterId 需要用 nanoid 生成、hostname 需要做 IP 校验,不适合在 SQL 里处理。

CREATE TABLE IF NOT EXISTS master_node (
  id                 TEXT PRIMARY KEY,                    -- 8 字符 base36,首次启动生成
  hostname           TEXT NOT NULL,                       -- 本机 hostname(非 IP,显示用)
  role               TEXT NOT NULL DEFAULT 'standalone',  -- standalone | coordination | member
  display_name       TEXT,                                -- 可读名(默认 = hostname)
  endpoint           TEXT,                                -- 对外 ws://host:port(联邦互联用)
  federation_enabled INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
