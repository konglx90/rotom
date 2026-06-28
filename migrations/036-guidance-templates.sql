-- 036: 群指导模板库 (guidance_templates)
-- 把「群指导 prompt」从裸 textarea 升级为可选模板库。每条模板包含 prompt_text
-- 和可选的 schedule_config(JSON)；选模板时填好 prompt,若带 schedule_config 则
-- 同时创建 scheduled_task。prompt_text 和 schedule_config 都支持 {{teacher}}/
-- {{student}}/{{topic}} 占位符,在前端选模板时填入。
-- 种子模板 is_default=1,UI 不允许删除;用户可自增模板。
CREATE TABLE IF NOT EXISTS guidance_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  prompt_text     TEXT NOT NULL,
  schedule_config TEXT,                          -- JSON, null=不带定时任务
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_default      INTEGER NOT NULL DEFAULT 1,    -- 1=种子模板,不可删
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

INSERT INTO guidance_templates (name, description, prompt_text, schedule_config, sort_order, is_default, created_at, updated_at) VALUES
('群内讨论方案设计',
 '不创建 issue，群内成员讨论完成方案设计',
 '本群通过群内成员讨论完成方案设计。不需要创建 issue 执行任务，所有方案讨论在群内进行。提问对方时用 #reply @对方。',
 NULL,
 1, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('群内讨论 + 老师定时检查',
 '群内讨论完成，老师 agent 每分钟检查一次讨论结果，8 分钟后结束',
 '本群通过群内成员讨论完成方案。不需要创建 issue。老师 {{teacher}} 每分钟会检查一次讨论结果，对 {{student}} 的回答给出赞同/反对/补充意见。8 分钟后结束。',
 json('{"mode":"agent","agent_name":"{{teacher}}","schedule_kind":"interval","interval_sec":60,"repeat_times":8,"prompt":"检查群内最近的讨论，作为老师 {{teacher}} 对学生 {{student}} 的回答给出赞同/反对/补充意见。"}'),
 2, 1, strftime('%s','now')*1000, strftime('%s','now')*1000),
('老师提问-学生回答-老师回应',
 '{{teacher}} 提问，{{student}} 回答或提意见，{{teacher}} 再赞同/反对/补充',
 '{{teacher}} 作为老师提问，{{student}} 作为学生回答或提出意见，{{teacher}} 再表示赞同/反对/补充。讨论话题：{{topic}}。提问对方时用 #reply @对方。',
 NULL,
 3, 1, strftime('%s','now')*1000, strftime('%s','now')*1000);
