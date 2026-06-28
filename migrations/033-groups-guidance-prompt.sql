-- 033: 群级别"群指导 prompt" —— 全群一份,群内所有 agent 被唤起时拼到 prompt 上。
-- 用于"本群讨论什么/不讨论什么""提问必须用 wrapper""输出格式约定"等群级硬规则。
-- NULL = 未设置,不拼接;空串视为清空(也不拼接)。
-- 由 enrichConversationWithCollaboration 读出,经 conversation.guidancePrompt 透传给
-- worker-chat,最终在 prompt-composer 里作为 group-guidance 层插入 group-basic 与 cwd 之间。
ALTER TABLE groups ADD COLUMN guidance_prompt TEXT;
