# Artifacts(产物)架构

Rotom 中 agent 在执行 issue 时产出的文件(代码、文档、diff)如何被归档、预览与对比。

## 1. 概念

"Artifacts" 不是一张单独的表,而是 **group 工作目录 + git worktree** 的视图。每个 group 可配置 `repo_url` / `repo_default_branch` / `extra_repos` / `worktree_mode`;agent 执行 issue 时在本机起 git worktree 改代码,产物留在 worktree 里,master 通过文件树 + git 命令把它们暴露给 Dashboard 预览/对比。

未配 repo 的 group:artifacts 就是 `group.working_dir` 下的普通文件树。

## 2. 数据模型(groups 表相关列)

| 列 | 含义 |
|---|---|
| `working_dir` | 无 repo 时的产物根目录(普通文件树) |
| `repo_url` | 主仓库地址 |
| `repo_default_branch` | 主仓库 base 分支(diff 的 base) |
| `extra_repos` | JSON 数组,额外只读挂载仓库 |
| `worktree_mode` | 是否启用 worktree(每 issue 独立 worktree) |

issues 表的 `repo_url` / `repo_branch` 可覆盖 group 级配置(migration 051)。

## 3. 关键文件

- `src/master/api/artifacts.ts` —— 全部 REST 端点
- `src/master/api/groups.ts` —— worktree 生命周期(`GET /groups/:id/worktree`、`GET /repos/worktrees`、`DELETE /repos/worktrees`)
- `src/executor/repo-cache.ts` / worktree 创建逻辑 —— executor 在本机起 worktree
- `packages/dashboard/.../ArtifactPanel.tsx` —— 前端文件树 + Monaco viewer + DiffEditor + 分支对比

## 4. REST 端点

| 方法 路径 | 作用 |
|---|---|
| `GET /artifacts/:groupId` | 文件树;注入 `__repos/` 虚拟节点展示主 worktree |
| `GET /artifacts/:groupId/content` | 单文件内容(`__repos/` 路径走 worktree base 切换) |
| `GET /artifacts/:groupId/original` | `git show <base>` 取基线版本 |
| `GET /artifacts/:groupId/diff` | `git diff` vs base(单文件) |
| `GET /artifacts/:groupId/refs` | 分支/tag 列表 + HEAD |
| `GET /artifacts/:groupId/branch-diff` | `base..head` name-status + numstat,500 文件截断 |
| `GET /artifacts/:groupId/content-at-ref` | 任意 ref 的文件内容(按 repo) |

## 5. 分支对比(branch-diff)

`GET /artifacts/:groupId/branch-diff` 接收 `base` / `head` ref,返回变更文件清单(name-status + 增删行数),前端用 `DiffEditor` 渲染。ref 列表从 group 的主仓库 + extra_repos 自动拉取。这是 commit `e508ec4` 新增的视图,用于"本分支 vs base 分支"的整体改动审阅,而非单文件 diff。

## 6. 与其他子系统关系

- **Issue**:issue 完成时把产物路径写回 `issues.artifacts`(JSON 数组),Dashboard issue 详情可直跳 artifact。
- **Sessions**:worktree 与 `(cli_tool, group, session)` 绑定,session 失效后 worktree 可被清理。
- **Patrol**:issue-patrol 巡检员只读 artifacts,不改。
