-- 052: group worktree 模式开关。
--
-- worktree_mode:
--   'group' (默认) —— 整个 group 共享一个 worktree(<groupDir>/repos/primary/),
--     issue 执行前 git checkout 到目标分支(同分支连续 issue 零成本,适合单分支
--     线性开发);切分支会互相打断,适合"群内 issue 不会大量同时开始"的场景。
--   'issue' —— 每 issue 独立 worktree + 派生分支 <branch>-rotom-<issueId8>,
--     多分支天然并行(适合多分支并发开发)。
--
-- 配了 repo_url 的 group 默认 'group'(轻量);需要并行时切 'issue'。

ALTER TABLE groups ADD COLUMN worktree_mode TEXT;
UPDATE groups SET worktree_mode = 'group' WHERE repo_url IS NOT NULL AND worktree_mode IS NULL;
