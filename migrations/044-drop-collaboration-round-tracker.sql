-- 044: drop collaboration_round_tracker (协作 issue 模式下线)
--
-- 协作 issue 整条线已从代码移除:群指导 prompt(guidance_prompt)+ 定时任务
-- (scheduled_tasks) 已经覆盖"多人讨论方案"场景,且更灵活。
--
-- 只 drop 独立的 round_tracker 表;issues 表的 collaboration_goal /
-- max_rounds / current_round / participants / owner / summary 六列保留
-- (SQLite 删列要表重建,得不偿失;nullable + 无代码引用 = 零运行时影响)。
DROP TABLE IF EXISTS collaboration_round_tracker;
