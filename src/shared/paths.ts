/**
 * Shared on-disk path constants + worktree path helpers.
 *
 * 单一路径真相源,master 与 executor 都从这导入,避免两处各自定义 `REPOS_ROOT` /
 * `ARTIFACTS_ROOT` 产生漂移。纯路径计算,不依赖 db / 不触碰 FS(除 `os.homedir()`)。
 *
 * 布局(统一后):
 *   ~/.rotom/artifacts/<groupId>/            ← 产物面板 root(单一父目录)
 *     ├── __repos/                            ← worktree 容器(walkDir 跳过)
 *     │   ├── primary/                        ← primary worktree(agent cwd)
 *     │   │   └── repos/<extraId> -> ../../<extraId>
 *     │   └── <extraId>/                      ← extra worktree
 *     └── (沙箱产物...)
 *   ~/.rotom/repos/<repoName>-<repoId8>.git/  ← bare clone,全局按 URL 共享
 *
 * worktree 路径不再含 url-hash —— 只 bare clone 需要 url 唯一性;worktree 是
 * per-group(或 per-issue)的 checkout,直接挂在 group 产物目录下,和产物同父。
 *
 * 跨机器:worktree 模式仅同机生效(`isAgentLocalToMaster`),master 与 executor
 * 同机 → 各自 `os.homedir()` 一致 → 算出同一路径。
 */

import os from "node:os";
import path from "node:path";

/** 产物根目录:每个 group 一个子目录,既是产物面板 root,也是 worktree 的父目录。 */
export const ARTIFACTS_ROOT = path.join(os.homedir(), ".rotom", "artifacts");

/** bare clone + worktree 容器的旧根(迁移前 worktree 在此)。bare clone 仍在此。 */
export const REPOS_ROOT = path.join(os.homedir(), ".rotom", "repos");

/**
 * Legacy 产物根(results → artifacts 重命名前)。只读 fallback,保证历史 group
 * 的数据仍能解析。与 group-paths.ts 原行为一致。
 */
export const LEGACY_RESULTS_ROOT = path.join(os.homedir(), ".rotom", "results");

/** worktree 容器目录名。walkDir 跳过此名,artifacts 面板把它当虚拟节点注入。 */
export const REPOS_DIR_NAME = "__repos";

/**
 * primary worktree 的 API 角色标识(`?repo=primary`、分支对比等用它指代主仓库)。
 * 注意:这是**角色 id**,不是磁盘目录名 —— primary 的目录名用仓库名(repoName),
 * 这样面板里 `__repos/<repoName>` 对人可读。`?repo=primary` 由 master 解析成 primary
 * worktree,与目录名解耦。
 */
export const PRIMARY_API_ID = "primary";

/** group 的产物根目录:~/.rotom/artifacts/<groupId>(完整 groupId,不截断)。 */
export function groupArtifactsDir(groupId: string): string {
  return path.join(ARTIFACTS_ROOT, groupId);
}

/** group 默认工作目录(等价于 groupArtifactsDir,保留旧名便于迁移)。 */
export function defaultGroupWorkingDir(groupId: string): string {
  return groupArtifactsDir(groupId);
}

/**
 * worktree 容器目录(不创建,只算路径)。
 *
 *   group 模式: <groupDir>/__repos
 *   issue 模式: <groupDir>/__repos/<issueId8>
 *
 * issue 模式把每个 issue 的工作树隔到独立子目录,互不干扰;group 模式所有 issue
 * 共享同一组 primary/extra worktree。
 */
export function groupReposContainer(
  groupId: string,
  mode: "group" | "issue",
  issueId8?: string,
): string {
  const base = path.join(groupArtifactsDir(groupId), REPOS_DIR_NAME);
  if (mode === "issue" && issueId8) {
    return path.join(base, issueId8);
  }
  return base;
}

/**
 * primary worktree 路径(agent cwd)。目录名用仓库名(primaryDirName = repoName),
 * 对人可读(`__repos/wario` 而非 `__repos/primary`)。
 * group 模式: <groupDir>/__repos/<primaryDirName>
 * issue 模式: <groupDir>/__repos/<issueId8>/<primaryDirName>
 *
 * @param primaryDirName 仓库名(repoNameFor(repoUrl)),由调用方算好传入——master 与
 *   executor 各自从 repoUrl 算同一个值,保证路径一致。
 */
export function primaryWorktreePath(
  groupId: string,
  mode: "group" | "issue",
  primaryDirName: string,
  issueId8?: string,
): string {
  return path.join(groupReposContainer(groupId, mode, issueId8), primaryDirName);
}

/**
 * extra worktree 路径。
 * group 模式: <groupDir>/__repos/<extraId>
 * issue 模式: <groupDir>/__repos/<issueId8>/<extraId>
 */
export function extraWorktreePath(
  groupId: string,
  extraId: string,
  mode: "group" | "issue",
  issueId8?: string,
): string {
  return path.join(groupReposContainer(groupId, mode, issueId8), extraId);
}

/**
 * extra worktree 挂到 primary 内 mountPath 的相对 symlink 目标。
 *
 * primary 在 <container>/primary/,extra 在 <container>/<extraId>/。
 * linkPath = <primary>/<mountPath>(mountPath 形如 `repos/<extraId>`),
 * 从 linkPath 的 dirname(<primary>/repos)到 extra(<container>/<extraId>)
 * 的相对路径固定为 `../../<extraId>`(上到 primary,上到 container,进 extra)。
 *
 * container 路径对 group/issue 模式都一致,故相对目标与模式无关。
 */
export function extraSymlinkTarget(extraId: string): string {
  return path.join("..", "..", extraId);
}

// ─── Skill 文件存储(文件 = 真相源)─────────────────────────────────────────
//
// skill 文档以 `~/.rotom/skills/<name>/SKILL.md` 落盘(frontmatter 元数据 +
// markdown 正文)。DB `agent_skills` 表降级为可重建索引(供 dashboard 列表 /
// 搜索 / view_count 统计),真相源始终是文件 —— `db.reconcileSkills()` 扫描
// 目录即可重建索引。
//
// 根目录按需计算(lazy):每次 FS 操作时读 `ROTOM_HOME`,故测试可在 before()
// 里设 process.env.ROTOM_HOME 隔离,无需子进程(与 skill-md.ts 的 eager 常量
// 不同)。env 覆盖 > 默认 ~/.rotom,与 skill-md.ts 对齐避免两个根漂移。

/** ROTOM_HOME:env 覆盖优先,默认 ~/.rotom。与 skill-md.ts 对齐。 */
export function rotomHome(): string {
  return process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
}

/** skill 文档根目录:`~/.rotom/skills`(每次调用现算,响应 ROTOM_HOME 变更)。 */
export function skillsRoot(): string {
  return path.join(rotomHome(), "skills");
}

/** skill 软删暂存目录(deactivateSkill 把整个 skill 目录移到这里,可恢复)。 */
export function skillsTrash(): string {
  return path.join(skillsRoot(), ".trash");
}

/** skill 文件名(对齐 Claude Code SKILL.md 规范)。 */
export const SKILL_FILE_NAME = "SKILL.md";

/** 单个 skill 的目录:`~/.rotom/skills/<name>`。 */
export function skillDir(name: string): string {
  return path.join(skillsRoot(), name);
}

/** 单个 skill 的 SKILL.md 路径:`~/.rotom/skills/<name>/SKILL.md`。 */
export function skillFilePath(name: string): string {
  return path.join(skillDir(name), SKILL_FILE_NAME);
}
