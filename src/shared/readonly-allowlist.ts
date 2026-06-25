/**
 * Read-only Bash command allowlist.
 *
 * Used by worker.onApprovalRequest to short-circuit the dashboard approval
 * flow for safe read-only commands under the `r_allow` policy. Designed
 * fail-closed: anything that *might* be a write or a compound construct
 * (pipes, redirects, command substitution, leading env assignment, line
 * continuation) makes the command NOT match — it falls through to the
 * existing human approval flow.
 *
 * Note: this only certifies the command shape is read-only. It does NOT
 * gate the *target* — `cat /etc/shadow` still passes because `cat` is
 * read-only. Secret/permission defenses rely on the executor's cwd being
 * pinned to a sandbox + the agent prompt; not on this list.
 *
 * Read/Grep/Glob (claude) and codex's built-in read tools are never hooked
 * by the approval gate, so they never reach this code path.
 */

// Single-token read-only commands. Bash built-ins and coreutils that only
// inspect the filesystem / process state.
export const READONLY_SINGLE: readonly string[] = [
  // 文件/目录浏览
  "ls", "tree",
  // 文件读取
  "cat", "head", "tail", "wc",
  // 元信息
  "file", "stat",
  // 搜索
  "find", "fd", "rg", "grep", "ag", "ack",
  // shell 内建只读
  "echo", "pwd",
  // 系统只读快照
  "whoami", "uname", "date",
  // 注:`env`/`printenv` 故意不放行 —— 全量打印环境变量会泄露 API_KEY 等
  // secret。`curl`/`wget`/`nc`/`bash -c`/`sh -c`/`eval`/`source` 也不放行。
];

// `<head> <sub>` 双 token 只读组合,主要覆盖多子命令工具(git/rotom)。
// 用 `${head} ${sub}` 字符串集合做精确匹配,避免 startsWith 误中。
export const READONLY_MULTI: readonly string[] = [
  // git 只读子命令(写类 add/commit/push/pull/reset/checkout/stash/clean/rm/tag/config 一律不放行)
  "git log", "git status", "git diff", "git show",
  "git branch", "git remote", "git rev-parse", "git ls-files",
  "git blame", "git ls-tree", "git shortlog", "git describe",
  // rotom 只读子命令(同样不放行 issue/agent 增删改类)
  "rotom status", "rotom whoami", "rotom --version", "rotom -v", "rotom help",
  // 运行时版本号(纯只读)
  "node --version", "node -v",
  "npm --version", "npm -v",
  "pnpm --version", "pnpm -v",
  "python --version", "python -V",
  "python3 --version", "python3 -V",
];

const SINGLE_SET: ReadonlySet<string> = new Set(READONLY_SINGLE);
const MULTI_SET: ReadonlySet<string> = new Set(READONLY_MULTI);

// 多子命令工具的 head —— 只有这些才查 MULTI 集合,避免 `cat_ls` 这种误中。
const MULTI_HEADS: ReadonlySet<string> = new Set([
  "git", "rotom", "node", "npm", "pnpm", "python", "python3",
]);

// 任一命中即视为复合/危险命令,fail-closed。逐项列出便于单测定位。
const DANGER_PATTERNS: readonly RegExp[] = [
  /\|/,      // 管道: cat a | rm b
  /&/,       // && / || / 后台 &
  /;/,       // 语句分隔: ls; rm x
  />/,       // 重定向写: echo > y
  /</,       // 重定向读 / heredoc
  /`/,       // 反引号命令替换
  /\$\(/,    // $(...) 命令替换
  /\$\{/,    // ${...} 参数展开(防 ${...} 嵌套命令)
  /\\/,      // 行续 `ls \\\n&& rm` 或转义
];

// 前导 env 赋值:`FOO=bar cmd ...` / `PATH=/x cmd ...`,防 PATH 劫持。
const LEADING_ENV_ASSIGN = /^[A-Za-z_]\w*=\S+/;

/**
 * Returns true iff `command` is unambiguously read-only and safe to
 * auto-approve. Conservative on purpose — when in doubt, returns false and
 * lets the human approval flow handle it.
 *
 * See file-top JSDoc for the safety contract.
 */
export function isReadonlyCommand(command: string | undefined): boolean {
  // 1. 非字符串 / 空
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  // 2. 危险字符短路
  for (const p of DANGER_PATTERNS) {
    if (p.test(trimmed)) return false;
  }

  // 3. 前导 env 赋值短路
  if (LEADING_ENV_ASSIGN.test(trimmed)) return false;

  // 4. tokenize
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;

  // 5. 取首个非 flag token 作为 head
  const headRaw = tokens.find((t) => !t.startsWith("-"));
  if (!headRaw) return false;

  // 6. basename 兼容 `/bin/ls` 形态(仅当 head 含 / 才做)
  const head = headRaw.includes("/")
    ? headRaw.split("/").pop() ?? headRaw
    : headRaw;

  // 7. 单 token 白名单
  if (SINGLE_SET.has(head)) return true;

  // 8. 多 token 白名单:head 必须是多子命令工具,第二个 token 原样查表。
  //    不再过滤 flag —— 因为 MULTI 集合里既有 `git log`(positional sub)
  //    也有 `node --version`(flag sub);MULTI 集合本身就是白名单,只要命中就放行。
  //    例:`git status --short` → head=git, sub=status(第二个 token) → 命中。
  //         `node --version`    → head=node, sub=--version → 命中。
  if (MULTI_HEADS.has(head) && tokens.length >= 2) {
    const sub = tokens[1];
    if (MULTI_SET.has(`${head} ${sub}`)) return true;
  }

  // 9. 否则 fail-closed
  return false;
}
