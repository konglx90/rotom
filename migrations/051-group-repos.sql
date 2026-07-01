-- 051: 内置 repos + git worktree 支持。
--
-- group 配了 repo_url 时,该 group 的每个 issue 在 executor 本机获得一个
-- 独立 git worktree 作为 cwd(`~/.rotom/artifacts/<groupId>/<issueId>/repos/primary/`),
-- 多分支天然隔离;bare clone 全局缓存在 `~/.rotom/repos/<repo-id>.git/`,跨 group/issue 共享。
-- 没配 repo_url 的 group 完全回退现状(`<base>/<groupId>` 直接当 cwd)。
--
-- extra_repos 是 JSON 数组,形如:
--   [{"id":"repo-b","url":"git@...","branch":"main","mountPath":"repos/repo-b"}]
-- 每个 extra 在 `<issueId>/repos/<id>/` 起独立 worktree,并在 primary 的 mountPath
-- 处建相对 symlink 让 agent 在 cwd 内直接访问。

ALTER TABLE groups ADD COLUMN repo_url TEXT;
ALTER TABLE groups ADD COLUMN repo_default_branch TEXT;
ALTER TABLE groups ADD COLUMN extra_repos TEXT;

ALTER TABLE issues ADD COLUMN repo_url TEXT;
ALTER TABLE issues ADD COLUMN repo_branch TEXT;
