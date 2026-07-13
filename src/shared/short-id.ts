/**
 * 短 ID 生成器 —— 12 字符 base62,供群 / issue / memory / scheduler run 等实体复用。
 *
 * 替代原先的 UUID v4(36 字符)。短 ID 让 artifacts 目录路径、git 派生分支名、
 * URL 等都更紧凑,同时仍满足全仓对这些 ID 的全部硬约束:
 *
 *  - 字符集 `[A-Za-z0-9]`:通过 `SAFE_ID = /^[A-Za-z0-9_-]+$/`(`sessions.ts`),
 *    不含 `:`(sessions.json key `${cliTool}:${groupId}` 按 `:` 分割,见
 *    `session-store.ts`),不含 `/` `.`(作目录名/URL 路径安全)。
 *  - 长度 12:62^12 ≈ 3.2e21(≈71 位熵),远超各实体规模需求。
 *  - `slice(0,8)` 派生 8 字符后缀:用于 git 派生分支 `<branch>-rotom-<id8>`
 *    (group 模式 `worker-worktrees.ts` 用 groupId8,issue 模式用 issueId8),
 *    8 字符 base62 ≈ 47 位熵,优于原 UUID8 的 32 位(8 hex),分支名碰撞更不易发生。
 *
 * 仅 master 侧调用生成;executor 从不生成这些 ID,只接收。
 */

import { randomBytes } from "node:crypto";

/** base62 字母表:数字 + 大写 + 小写。不含 `-`/`_`,作文件名/分支名/URL 均安全。 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ALPHABET_LEN = 62; // 62
/** 接受区间上限(62 的最大整数倍,排除以消除取模偏差)。 */
const ALPHABET_MAX_ACCEPT = Math.floor(256 / ALPHABET_LEN) * ALPHABET_LEN; // 248

/**
 * 生成一个 12 字符 base62 短 ID(群 / issue / memory / scheduler run 通用)。
 *
 * 用 rejection sampling 消除取模偏差:每个随机字节 ≥ 248 时丢弃重取,
 * 保证 62 个字符等概率分布。
 *
 * @param len 长度,默认 12
 */
export function generateShortId(len = 12): string {
  const out: string[] = [];
  while (out.length < len) {
    const buf = randomBytes(len * 2); // 批量取,减少 syscall
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b < ALPHABET_MAX_ACCEPT) {
        out.push(ALPHABET[b % ALPHABET_LEN]);
      }
    }
  }
  return out.join("");
}
