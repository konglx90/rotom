-- 023: Issue comment & reply-to — 支持 issue 内消息回复/引用
--
-- 在 issue_events 中添加 reply_to_id 列，允许对已有事件/消息回复。
-- 新增 comment 事件类型用于普通消息（区别于 collaboration_turn），
-- reply_to_id 指向被回复的 issue_events.id。

ALTER TABLE issue_events ADD COLUMN reply_to_id INTEGER REFERENCES issue_events(id);
