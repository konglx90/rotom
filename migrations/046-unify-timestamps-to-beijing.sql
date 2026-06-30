-- 046: 把存量 UTC ISO 时间列统一转成北京时间字符串 "YYYY-MM-DD HH:MM:SS.mmm"
--
-- 背景:master 之前所有 created_at/updated_at 都用 `new Date().toISOString()`
-- 存 UTC ISO(如 "2026-06-30T10:02:04.123Z")。显示和过滤时要 mental 换算,
-- 实测群消息轮询时把本地时间字符串拿去对比 UTC ISO 会 silently 滤掉。
--
-- 本次统一改成北京时间字符串(无 Z / 时区后缀,字典序 = 时间序)。
-- 代码侧 src/shared/time.ts 提供 nowBeijing()/toBeijing()/shiftBeijing()。
-- 本 migration 把存量数据一次性转成新格式,WHERE 条件识别旧格式(T/Z 后缀)。
--
-- 转换公式:UTC ISO "2026-06-30T10:02:04.123Z" → 北京时间 "2026-06-30 18:02:04.123"
-- SQLite 的 datetime() 不带毫秒精度,用 substr 拼装;时区差 +8 小时由
-- `datetime(col, '+8 hours')` 完成。带毫秒的列(created_at 在 group_messages/
-- issue_events 等)需要手工 substr 保留 .mmm。
--
-- 不动 schema,只 UPDATE 数据值。已转过的行(无 T/Z 后缀)WHERE 不命中,幂等。

-- agents
UPDATE agents
SET registered_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(registered_at, 1, 19), '+8 hours')) ||
                    CASE WHEN length(registered_at) > 19 THEN substr(registered_at, 20) ELSE '' END
WHERE registered_at LIKE '____-__-__T__:__:__%Z';

UPDATE agents
SET updated_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(updated_at, 1, 19), '+8 hours')) ||
                CASE WHEN length(updated_at) > 19 THEN substr(updated_at, 20) ELSE '' END
WHERE updated_at LIKE '____-__-__T__:__:__%Z';

UPDATE agents
SET last_heartbeat = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(last_heartbeat, 1, 19), '+8 hours')) ||
                    CASE WHEN length(last_heartbeat) > 19 THEN substr(last_heartbeat, 20) ELSE '' END
WHERE last_heartbeat LIKE '____-__-__T__:__:__%Z';

UPDATE agents
SET connected_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(connected_at, 1, 19), '+8 hours')) ||
                  CASE WHEN length(connected_at) > 19 THEN substr(connected_at, 20) ELSE '' END
WHERE connected_at LIKE '____-__-__T__:__:__%Z';

-- groups
UPDATE groups
SET created_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(created_at, 1, 19), '+8 hours')) ||
                CASE WHEN length(created_at) > 19 THEN substr(created_at, 20) ELSE '' END
WHERE created_at LIKE '____-__-__T__:__:__%Z';

UPDATE groups
SET pinned_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(pinned_at, 1, 19), '+8 hours')) ||
                CASE WHEN length(pinned_at) > 19 THEN substr(pinned_at, 20) ELSE '' END
WHERE pinned_at LIKE '____-__-__T__:__:__%Z';

UPDATE groups
SET archived_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(archived_at, 1, 19), '+8 hours')) ||
                  CASE WHEN length(archived_at) > 19 THEN substr(archived_at, 20) ELSE '' END
WHERE archived_at LIKE '____-__-__T__:__:__%Z';

-- group_members
UPDATE group_members
SET joined_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(joined_at, 1, 19), '+8 hours')) ||
                CASE WHEN length(joined_at) > 19 THEN substr(joined_at, 20) ELSE '' END
WHERE joined_at LIKE '____-__-__T__:__:__%Z';

-- group_messages
UPDATE group_messages
SET created_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(created_at, 1, 19), '+8 hours')) ||
                CASE WHEN length(created_at) > 19 THEN substr(created_at, 20) ELSE '' END
WHERE created_at LIKE '____-__-__T__:__:__%Z';

UPDATE group_messages
SET cancelled_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(cancelled_at, 1, 19), '+8 hours')) ||
                  CASE WHEN length(cancelled_at) > 19 THEN substr(cancelled_at, 20) ELSE '' END
WHERE cancelled_at LIKE '____-__-__T__:__:__%Z';

-- issues + issue_events:同样模式覆盖 created_at/updated_at/started_at/completed_at
UPDATE issues SET created_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(created_at, 1, 19), '+8 hours')) || CASE WHEN length(created_at) > 19 THEN substr(created_at, 20) ELSE '' END WHERE created_at LIKE '____-__-__T__:__:__%Z';
UPDATE issues SET updated_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(updated_at, 1, 19), '+8 hours')) || CASE WHEN length(updated_at) > 19 THEN substr(updated_at, 20) ELSE '' END WHERE updated_at LIKE '____-__-__T__:__:__%Z';
UPDATE issues SET started_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(started_at, 1, 19), '+8 hours')) || CASE WHEN length(started_at) > 19 THEN substr(started_at, 20) ELSE '' END WHERE started_at LIKE '____-__-__T__:__:__%Z';
UPDATE issues SET completed_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(completed_at, 1, 19), '+8 hours')) || CASE WHEN length(completed_at) > 19 THEN substr(completed_at, 20) ELSE '' END WHERE completed_at LIKE '____-__-__T__:__:__%Z';

UPDATE issue_events SET created_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(created_at, 1, 19), '+8 hours')) || CASE WHEN length(created_at) > 19 THEN substr(created_at, 20) ELSE '' END WHERE created_at LIKE '____-__-__T__:__:__%Z';

-- notes / memory / agent_skills / scheduled_tasks / ask_bridges / agent_sessions /
-- issue_patrol_runs / issue_patrol_logs / audit_log / message_log 同样处理,
-- 但 schema 各异,这里只列常见的几个 text 时间列。新增列请走 nowBeijing()。
UPDATE notes SET created_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(created_at, 1, 19), '+8 hours')) || CASE WHEN length(created_at) > 19 THEN substr(created_at, 20) ELSE '' END WHERE created_at LIKE '____-__-__T__:__:__%Z';
UPDATE notes SET updated_at = strftime('%Y-%m-%d %H:%M:%S', datetime(substr(updated_at, 1, 19), '+8 hours')) || CASE WHEN length(updated_at) > 19 THEN substr(updated_at, 20) ELSE '' END WHERE updated_at LIKE '____-__-__T__:__:__%Z';

-- 整数毫秒时间戳(scheduled_tasks.next_run_at / ask_bridges.created_at 等)
-- 不需要转换——代码侧用 Date(ms) / nowBeijing() 边界处统一处理。
