-- 037: 调度模式参考库 (schedule_patterns)
-- 常见定时任务模式的参考/学习库,供用户在配置群指导模板时引用。
-- 不直接管理群内生产任务(scheduled_tasks),只是模式样板。
-- 种子模式 is_default=1,UI 不允许删除;用户可自增模式。
CREATE TABLE IF NOT EXISTS schedule_patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  schedule_config TEXT,                          -- JSON, null=纯展示无配置
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_default      INTEGER NOT NULL DEFAULT 0,    -- 1=种子模式,不可删
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

INSERT INTO schedule_patterns (name, description, schedule_config, sort_order, is_default, created_at, updated_at) VALUES
('每 60 秒轮询检查',
 'interval 模式,固定 60 秒触发一次,适合高频巡检类任务',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":60,"repeat_times":10,"prompt":"检查最新进展并给出反馈。"}'),
 1, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('一次性定时提醒',
 'once 模式,在指定时间点触发一次后结束',
 json('{"mode":"message","schedule_kind":"once","run_at":0,"prompt":"到点了,该开始了。"}'),
 2, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('每日固定周期播报',
 'interval 模式,86400 秒(一天)周期触发,适合每日晨会/日报类任务',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":86400,"repeat_times":null,"prompt":"生成今日总结并发到群里。"}'),
 3, 1, strftime('%s','now')*1000, strftime('%s','now')*1000);
