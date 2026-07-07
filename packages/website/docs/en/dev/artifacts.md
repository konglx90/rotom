# Artifacts Architecture

How files produced by agents during issue execution are archived, previewed, and diffed in Rotom.

## 1. Concept

"Artifacts" is not a separate table — it is a view over the **group working directory + git worktrees**. Each group may configure `repo_url` / `repo_default_branch` / `extra_repos` / `worktree_mode`. When an agent executes an issue it spins up a git worktree locally; the produced files live in that worktree, and master exposes them to the dashboard via file-tree + git commands.

For groups without a repo, artifacts are the plain file tree under `group.working_dir`.

## 2. Data model (groups table columns)

| Column | Meaning |
|---|---|
| `working_dir` | Artifact root when no repo (plain file tree) |
| `repo_url` | Primary repo URL |
| `repo_default_branch` | Base branch for diffs |
| `extra_repos` | JSON array of extra read-only mounts |
| `worktree_mode` | Whether per-issue worktrees are enabled |

`issues.repo_url` / `repo_branch` override group-level config (migration 051).

## 3. Key files

- `src/master/api/artifacts.ts` — all REST endpoints
- `src/master/api/groups.ts` — worktree lifecycle (`GET /groups/:id/worktree`, `GET /repos/worktrees`, `DELETE /repos/worktrees`)
- `src/executor/repo-cache.ts` — local worktree creation
- `packages/dashboard/.../ArtifactPanel.tsx` — file tree + Monaco viewer + DiffEditor + branch diff

## 4. REST endpoints

| Method path | Purpose |
|---|---|
| `GET /artifacts/:groupId` | File tree; injects `__repos/` virtual node |
| `GET /artifacts/:groupId/content` | Single file content (swaps worktree base for `__repos/`) |
| `GET /artifacts/:groupId/original` | `git show <base>` |
| `GET /artifacts/:groupId/diff` | `git diff` vs base (single file) |
| `GET /artifacts/:groupId/refs` | branches/tags + HEAD |
| `GET /artifacts/:groupId/branch-diff` | `base..head` name-status + numstat (500-file cap) |
| `GET /artifacts/:groupId/content-at-ref` | file content at any ref |

## 5. Branch diff

`GET /artifacts/:groupId/branch-diff` takes `base` / `head` refs and returns the changed-file list (name-status + +/- lines); the dashboard renders it with `DiffEditor`. Refs are auto-fetched from the group's primary + extra repos. Added in commit `e508ec4` for whole-branch review rather than single-file diff.

## 6. Relationships

- **Issue**: on completion, artifact paths are written back to `issues.artifacts` (JSON).
- **Sessions**: worktree is tied to `(cli_tool, group, session)`.
- **Patrol**: issue-patrol reads artifacts read-only.
