/**
 * Executor-side bare clone + git worktree cache.
 *
 * 全局复用:同一 repo_url 在 `~/.rotom/repos/<repo-id>.git/` 只裸克隆一次,
 * 跨 group/issue 共享对象库。每个 issue 在 `<groupDir>/<issueId>/repos/<id>/`
 * 获得一个独立 worktree(分支隔离),多分支并行天然可用。
 *
 * 幂等性:ensureBareClone 二次调用只 `git fetch --prune`;addWorktree 在 worktree
 * 已存在时直接复用、分支已存在时基于该分支创建。离线时 fetch 失败降级用本地缓存。
 *
 * 与 master 解耦:本模块只在 executor 侧运行,master 不碰工作 FS(跨机器部署安全)。
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-executor-repo-cache", { stream: "stderr" });

/** Bare clone 缓存根目录。与 ARTIFACTS_ROOT 同源(~/.rotom/)。 */
export const REPOS_ROOT = path.join(os.homedir(), ".rotom", "repos");

/**
 * 给定 repo URL 计算稳定 repo-id。URL 归一化(去 .git 后缀、去协议前缀)后取
 * SHA-1 前 12 位,保证同 URL 在不同进程/机器算出同 id。短到能直接当目录名。
 */
export function repoIdFor(url: string): string {
  let u = url.trim();
  // 去 .git 后缀
  if (u.endsWith(".git")) u = u.slice(0, -4);
  // 去 ssh:// / https:// / git@ 前缀,只保留 host/path 部分
  u = u.replace(/^ssh:\/\/([^@]+@)?/, "").replace(/^https?:\/\//, "");
  u = u.replace(/^git@/, "");
  // 去 trailing slash
  u = u.replace(/\/$/, "");
  return createHash("sha1").update(u).digest("hex").slice(0, 12);
}

/**
 * 从 URL 提取仓库名(最后一段,去 .git 后缀)。用于路径可读性,让人一眼看出
 * 是哪个仓库。仅做展示,唯一性仍由 repoId 保证。
 *
 * 例:
 *   git@github.com:org/repo.git        → repo
 *   https://code.alipay.com/kael/kael-trade-h5.git → kael-trade-h5
 *   /tmp/origin.git                    → origin
 */
export function repoNameFor(url: string): string {
  let u = url.trim();
  if (u.endsWith(".git")) u = u.slice(0, -4);
  // 取最后一段(去 query/hash/trailing slash)
  u = u.split("?")[0].split("#")[0].replace(/\/$/, "");
  const last = u.split("/").pop() || "repo";
  // 兜底:若 last 为空(如 URL 是 host 根),用 "repo"
  return last || "repo";
}

/** bare clone 路径:`~/.rotom/repos/<repoName>-<repoId8>.git/`。
 *  repoName 做可读性,repoId8 做唯一性(避免同名不同 URL 冲突)。 */
function barePath(url: string): string {
  const repoId = repoIdFor(url);
  const repoName = repoNameFor(url);
  return path.join(REPOS_ROOT, `${repoName}-${repoId.slice(0, 8)}.git`);
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function runGit(args: string[], opts?: { cwd?: string }): GitResult {
  const r = spawnSync("git", args, {
    cwd: opts?.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: r.status === 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    code: r.status,
  };
}

/**
 * 异步版 runGit,用 spawn 而非 spawnSync。issue 执行路径用这个,避免 bare clone
 * (可能几分钟)阻塞 executor 的其他 WS 处理(心跳、chat 取消、其他 issue 进度等)。
 *
 * 返回 GitResult,与 runGit 同形。stdout/stderr 累积在内存(单次 git 输出不大,
 * 不会爆)。进程被 signal 杀掉时 ok=false。
 */
function runGitAsync(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("git", args, {
      cwd: opts?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: stderr + `\nspawn error: ${err.message}`, code: null });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

/** fs.realpathSync 的安全版:路径不存在时返回原值(不抛错)。用于幂等检查时归一化
 *  symlink(macOS /tmp → /private/tmp 等)。 */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** 确保 REPOS_ROOT 存在。幂等。 */
function ensureReposRoot(): void {
  fs.mkdirSync(REPOS_ROOT, { recursive: true });
}

/** 给定 URL 算出 bare clone 路径(不克隆,只算路径)。用于 cleanup 时
 *  拿到 barePath 做 `git worktree remove` 的 cwd,不需要真的 clone。 */
export function getBarePathForUrl(url: string): string {
  return barePath(url);
}

/**
 * 算出 worktree 的全局路径(不创建,只算路径)。
 *
 * 布局:~/.rotom/repos/<repo-id>-wt/<slot>/
 *   - group 模式:slot = `group-<groupId8>`(每 group 一个 worktree,跨群不共享)
 *   - issue 模式:slot = `<issueId8>`(per-issue)
 *
 * 全局放,不跟 group 走(用户需求:worktree 是机器级资源,不属于某个 group)。
 * bare clone 对象库仍全局共享,worktree 只占 checkout 文件空间。
 */
export function getWorktreePathForUrl(url: string, slot: string): string {
  const repoId = repoIdFor(url);
  const repoName = repoNameFor(url);
  return path.join(REPOS_ROOT, `${repoName}-${repoId.slice(0, 8)}-wt`, slot);
}

/**
 * 确保某 URL 的 bare clone 存在并是最新的。
 *
 * - 不存在 → `git clone --bare <url> <repoId>.git/`
 * - 已存在 → `git fetch --prune` 增量更新;fetch 失败(离线)降级 warn,不抛错,
 *   让调用方继续用本地缓存起 worktree(可能 stale 但至少能跑)
 *
 * 返回 { repoId, barePath }。失败(首次 clone 失败、且本地无缓存)抛错。
 */
export function ensureBareClone(url: string): { repoId: string; barePath: string } {
  ensureReposRoot();
  const repoId = repoIdFor(url);
  const bp = barePath(url);
  const alreadyExists = fs.existsSync(bp);

  if (!alreadyExists) {
    const r = runGit(["clone", "--bare", url, bp]);
    if (!r.ok) {
      throw new Error(`bare clone failed for ${url}: ${r.stderr || r.stdout || "(no stderr)"}`);
    }
  } else {
    // 已存在 → fetch --prune。离线时静默降级。
    const r = runGit(["fetch", "--prune"], { cwd: bp });
    if (!r.ok) {
      log.warn(`fetch failed (offline?) for ${repoId}: ${r.stderr || r.stdout || "(no stderr)"} — using local cache`);
    }
  }
  return { repoId, barePath: bp };
}

/**
 * 在 bare clone 上创建 worktree。
 *
 * bare clone 把源仓库的 refs/heads/* 直接拷贝到自己的 refs/heads/*(不像普通
 * clone 那样放在 refs/remotes/origin/*),所以 startPoint 直接用 `<branch>` 即可。
 *
 * 多 issue 同分支冲突:git worktree 不允许同一本地分支在多个 worktree 同时
 * checkout。为避免冲突,本函数为每个 issue 派生一个独立本地分支:
 *   `<branch>-rotom-<issueId8>` (issueId8 取传入的 issueId 前 8 字符)
 * 基于 `refs/heads/<branch>` 起点。agent 在 worktree 看到该派生分支,知道自己是
 * 从目标分支派生的,可自行 push 回去(若 remote 配置允许)。
 *
 * issueId8 缺省时退化为 `tmp` 前缀(不推荐,可能冲突)。
 *
 * 幂等:worktree 路径已存在且是有效 worktree → 直接返回。分支已存在但 worktree
 * 不存在 → `-B` 重置该分支到 startPoint 后再 add。
 */
export function addWorktree(
  barePath: string,
  worktreePath: string,
  branch?: string,
  issueId8?: string,
): string {
  // 已存在则视为幂等成功。检查是否是 worktree:用 `git worktree list` 看是否包含。
  if (fs.existsSync(worktreePath)) {
    const list = runGit(["worktree", "list", "--porcelain"], { cwd: barePath });
    if (list.ok) {
      // macOS 下 /tmp 是 /private/tmp 的 symlink,git 输出真实路径而传入的可能是
      // symlink 路径,两边都 realpath 归一化后再比对。
      const targetReal = safeRealpath(worktreePath);
      const matched = list.stdout.split("\n").some(line => {
        if (!line.startsWith("worktree ")) return false;
        const listed = line.slice("worktree ".length);
        return safeRealpath(listed) === targetReal;
      });
      if (matched) return worktreePath;
    }
    // 路径存在但不是 worktree —— 可能是残留空目录,删掉重建
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // 确保 worktree 父目录存在
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // 派生本地分支名:为每个 issue 独立,避免同分支多 worktree 冲突
  const suffix = issueId8 && issueId8.length >= 8 ? issueId8.slice(0, 8) : (issueId8 || "tmp");
  const localBranch = branch ? `${branch}-rotom-${suffix}` : `rotom-${suffix}`;

  // startPoint:若 branch 给了,从 refs/heads/<branch> 起(bare clone 的 head 引用);
  // 否则用 HEAD(仓库默认分支)
  const startPoint = branch ? `refs/heads/${branch}` : "HEAD";

  // 先 -B 创建/重置本地分支,再 worktree add 到该分支
  // (分两步是因为 `worktree add -B <branch> <path> <startPoint>` 在某些 git 版本下
  //  会把 startPoint 误判成要 checkout 的引用而非分支起点,导致 detached)
  const resetRes = runGit(["branch", "-f", localBranch, startPoint], { cwd: barePath });
  if (!resetRes.ok) {
    // 本地分支不存在时 `branch -f` 会创建,但若 startPoint 也不存在(分支名拼错)
    // 则失败。尝试不指定 startPoint,用 HEAD 兜底
    const fallbackBranch = runGit(["branch", localBranch], { cwd: barePath });
    if (!fallbackBranch.ok && !resetRes.stdout.includes("already exists")) {
      throw new Error(`worktree branch setup failed for ${localBranch} (start=${startPoint}): ${resetRes.stderr || resetRes.stdout}`);
    }
  }

  const addRes = runGit(["worktree", "add", "--force", worktreePath, localBranch], { cwd: barePath });
  if (!addRes.ok) {
    // 兜底:detached HEAD checkout,保证至少能跑
    const fallback = runGit(["worktree", "add", "--force", "--detach", worktreePath, startPoint], { cwd: barePath });
    if (!fallback.ok) {
      throw new Error(`worktree add failed for ${worktreePath} (branch=${localBranch}, start=${startPoint}): ${addRes.stderr || addRes.stdout}\n--- fallback detach ---\n${fallback.stderr || fallback.stdout}`);
    }
  }
  return worktreePath;
}

/**
 * 把已存在的 worktree 切到目标分支。group 模式下,issue 执行前调这个
 * 让共享 worktree 切到 issue 想要的分支(同分支连续 issue 零成本,切分支有成本)。
 *
 * branch 缺省时切到仓库默认分支(不动)。
 * 切换失败(有未提交改动 / 分支不存在)只 warn,不抛——让 agent 在当前分支继续跑,
 * 避免因 checkout 失败阻塞 issue 流程。
 */
export function checkoutWorktree(worktreePath: string, branch?: string): boolean {
  if (!branch) return true;
  if (!fs.existsSync(worktreePath)) return false;
  // 先检查当前分支是否已是目标,避免无谓的 checkout
  const headRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
  if (headRes.ok && headRes.stdout.trim() === branch) return true;
  // checkout 目标分支(本地分支名,refs/heads/<branch>)
  const r = runGit(["checkout", branch], { cwd: worktreePath });
  if (!r.ok) {
    // 分支可能不存在(没 fetch 到),尝试从 origin 拉
    const fetchR = runGit(["fetch", "origin", `${branch}:${branch}`], { cwd: worktreePath });
    if (fetchR.ok) {
      const r2 = runGit(["checkout", branch], { cwd: worktreePath });
      if (!r2.ok) {
        log.warn(`checkout ${branch} failed in ${worktreePath}: ${r2.stderr || r2.stdout}`);
        return false;
      }
      return true;
    }
    log.warn(`checkout ${branch} failed in ${worktreePath}: ${r.stderr || r.stdout}`);
    return false;
  }
  return true;
}

/**
 * 异步版 addWorktree。语义与同步版完全一致,用 spawn 避免 spawnSync 阻塞。
 * worktree 路径已存在且是有效 worktree → 幂等返回;否则创建派生分支 + add。
 */
export async function addWorktreeAsync(
  barePath: string,
  worktreePath: string,
  branch?: string,
  issueId8?: string,
): Promise<string> {
  if (fs.existsSync(worktreePath)) {
    const list = await runGitAsync(["worktree", "list", "--porcelain"], { cwd: barePath });
    if (list.ok) {
      const targetReal = safeRealpath(worktreePath);
      const matched = list.stdout.split("\n").some(line => {
        if (!line.startsWith("worktree ")) return false;
        const listed = line.slice("worktree ".length);
        return safeRealpath(listed) === targetReal;
      });
      if (matched) return worktreePath;
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const suffix = issueId8 && issueId8.length >= 8 ? issueId8.slice(0, 8) : (issueId8 || "tmp");
  const localBranch = branch ? `${branch}-rotom-${suffix}` : `rotom-${suffix}`;
  const startPoint = branch ? `refs/heads/${branch}` : "HEAD";

  const resetRes = await runGitAsync(["branch", "-f", localBranch, startPoint], { cwd: barePath });
  if (!resetRes.ok) {
    const fallbackBranch = await runGitAsync(["branch", localBranch], { cwd: barePath });
    if (!fallbackBranch.ok && !resetRes.stdout.includes("already exists")) {
      throw new Error(`worktree branch setup failed for ${localBranch} (start=${startPoint}): ${resetRes.stderr || resetRes.stdout}`);
    }
  }

  const addRes = await runGitAsync(["worktree", "add", "--force", worktreePath, localBranch], { cwd: barePath });
  if (!addRes.ok) {
    const fallback = await runGitAsync(["worktree", "add", "--force", "--detach", worktreePath, startPoint], { cwd: barePath });
    if (!fallback.ok) {
      throw new Error(`worktree add failed for ${worktreePath} (branch=${localBranch}, start=${startPoint}): ${addRes.stderr || addRes.stdout}\n--- fallback detach ---\n${fallback.stderr || fallback.stdout}`);
    }
  }
  return worktreePath;
}

/**
 * 异步版 checkoutWorktree。group 模式下 issue 执行前调,切到目标分支。
 */
export async function checkoutWorktreeAsync(worktreePath: string, branch?: string): Promise<boolean> {
  if (!branch) return true;
  if (!fs.existsSync(worktreePath)) return false;
  const headRes = await runGitAsync(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
  if (headRes.ok && headRes.stdout.trim() === branch) return true;
  const r = await runGitAsync(["checkout", branch], { cwd: worktreePath });
  if (!r.ok) {
    const fetchR = await runGitAsync(["fetch", "origin", `${branch}:${branch}`], { cwd: worktreePath });
    if (fetchR.ok) {
      const r2 = await runGitAsync(["checkout", branch], { cwd: worktreePath });
      if (!r2.ok) {
        log.warn(`checkout ${branch} failed in ${worktreePath}: ${r2.stderr || r2.stdout}`);
        return false;
      }
      return true;
    }
    log.warn(`checkout ${branch} failed in ${worktreePath}: ${r.stderr || r.stdout}`);
    return false;
  }
  return true;
}

/**
 * 移除一个 worktree。幂等:不存在的路径直接返回 true。
 * 失败(进程占用等)也返回 true 而不抛错 —— 调用方不应因清理失败阻塞 issue 流程。
 */
export function removeWorktree(barePath: string, worktreePath: string): boolean {
  if (!fs.existsSync(worktreePath)) return true;
  const r = runGit(["worktree", "remove", "--force", worktreePath], { cwd: barePath });
  if (!r.ok) {
    // 兜底:prune + 物理删除
    runGit(["worktree", "prune"], { cwd: barePath });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  return true;
}

/**
 * 列出本机所有 bare clone + 各自活跃 worktree 数。供 `rotom repo list` 用。
 */
export function listBareClones(): { repoId: string; barePath: string; worktrees: { path: string; branch: string }[]; sizeBytes: number }[] {
  if (!fs.existsSync(REPOS_ROOT)) return [];
  const entries = fs.readdirSync(REPOS_ROOT, { withFileTypes: true });
  const result: { repoId: string; barePath: string; worktrees: { path: string; branch: string }[]; sizeBytes: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith(".git")) continue;
    const repoId = e.name.slice(0, -4);
    const bp = path.join(REPOS_ROOT, e.name);
    const wtList = runGit(["worktree", "list", "--porcelain"], { cwd: bp });
    const worktrees: { path: string; branch: string }[] = [];
    if (wtList.ok) {
      let curPath = "";
      for (const line of wtList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length);
        else if (line.startsWith("branch ") && curPath) {
          // porcelain 输出 refs/heads/<branch>,剥成短分支名
          const ref = line.slice("branch ".length);
          const short = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
          worktrees.push({ path: curPath, branch: short });
          curPath = "";
        } else if (line === "" && curPath) {
          curPath = "";
        }
      }
    }
    const sizeBytes = dirSize(bp);
    result.push({ repoId, barePath: bp, worktrees, sizeBytes });
  }
  return result;
}

function dirSize(p: string): number {
  let total = 0;
  try {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          try { total += fs.statSync(full).size; } catch { /* skip */ }
        }
      }
    };
    walk(p);
  } catch { /* skip */ }
  return total;
}

/**
 * 异步版 ensureBareClone。issue 执行路径用这个,避免 clone(可能几分钟)阻塞
 * executor 的其他 WS 处理。失败语义与同步版一致:首次 clone 失败抛错,fetch 失败降级。
 */
export async function ensureBareCloneAsync(url: string): Promise<{ repoId: string; barePath: string }> {
  ensureReposRoot();
  const repoId = repoIdFor(url);
  const bp = barePath(url);
  const alreadyExists = fs.existsSync(bp);

  if (!alreadyExists) {
    const r = await runGitAsync(["clone", "--bare", url, bp]);
    if (!r.ok) {
      throw new Error(`bare clone failed for ${url}: ${r.stderr || r.stdout || "(no stderr)"}`);
    }
  } else {
    const r = await runGitAsync(["fetch", "--prune"], { cwd: bp });
    if (!r.ok) {
      log.warn(`fetch failed (offline?) for ${repoId}: ${r.stderr || r.stdout || "(no stderr)"} — using local cache`);
    }
  }
  return { repoId, barePath: bp };
}

/**
 * 显式 fetch 某 bare clone(供 `rotom repo fetch` 用)。
 * 返回 git 输出供 CLI 展示。
 */
/**
 * 显式 fetch 某 bare clone(供 `rotom repo fetch` 用)。
 * repoKey 是 listBareClones 返回的 repoId 字段(完整目录名,含 repoName)。
 */
export function fetchBareClone(repoKey: string): { ok: boolean; output: string } {
  const bp = path.join(REPOS_ROOT, `${repoKey}.git`);
  if (!fs.existsSync(bp)) return { ok: false, output: `repo ${repoKey} not found` };
  const r = runGit(["fetch", "--prune"], { cwd: bp });
  return { ok: r.ok, output: r.ok ? r.stdout : `${r.stderr || r.stdout}` };
}

/**
 * 删除 bare clone。要求无活跃 worktree(否则 git 会拒绝,我们也再保险一层)。
 * 供 `rotom repo remove` 用。bare clone 全局共享,删除前必须确认。
 * repoKey 是 listBareClones 返回的 repoId 字段(完整目录名)。
 */
export function removeBareClone(repoKey: string): { ok: boolean; error?: string } {
  const bp = path.join(REPOS_ROOT, `${repoKey}.git`);
  if (!fs.existsSync(bp)) return { ok: false, error: `repo ${repoKey} not found` };
  // 检查 worktree list 是否除了 bare 自己以外还有其他 worktree
  const list = runGit(["worktree", "list"], { cwd: bp });
  if (list.ok) {
    const lines = list.stdout.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      return { ok: false, error: `repo ${repoKey} 仍有 ${lines.length - 1} 个活跃 worktree,先清理它们` };
    }
  }
  fs.rmSync(bp, { recursive: true, force: true });
  return { ok: true };
}

/**
 * prune:清理孤儿 worktree 元数据 + 可选删除无引用的 bare clone。
 * `removeOrphans=true` 时删除无任何 worktree 引用且 30 天未 fetch 的 bare clone。
 */
export function pruneRepoCache(opts?: { removeOrphans?: boolean }): { prunedWorktrees: number; removedClones: string[] } {
  let prunedWorktrees = 0;
  const removedClones: string[] = [];
  if (!fs.existsSync(REPOS_ROOT)) return { prunedWorktrees: 0, removedClones };
  for (const e of fs.readdirSync(REPOS_ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.endsWith(".git")) continue;
    const repoId = e.name.slice(0, -4);
    const bp = path.join(REPOS_ROOT, e.name);
    const prune = runGit(["worktree", "prune", "-v"], { cwd: bp });
    if (prune.ok && prune.stdout.trim()) prunedWorktrees++;
    if (opts?.removeOrphans) {
      const list = runGit(["worktree", "list"], { cwd: bp });
      if (list.ok) {
        const lines = list.stdout.split("\n").filter(l => l.trim());
        if (lines.length <= 1) {
          // 仅 bare 自己,无活跃 worktree
          try {
            const st = fs.statSync(bp);
            const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays > 30) {
              fs.rmSync(bp, { recursive: true, force: true });
              removedClones.push(repoId);
            }
          } catch { /* skip */ }
        }
      }
    }
  }
  return { prunedWorktrees, removedClones };
}
