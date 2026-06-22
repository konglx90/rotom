import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const ROTOM_SKILL_MD = path.join(ROTOM_HOME, "SKILL.md");

/**
 * 把仓库内的 `skill/rotom-a2a-communicate/SKILL.md` 写到 `~/.rotom/SKILL.md`。
 *
 * 幂等:内容相同就跳过,不触发文件 mtime 变化(避免和正在跑的 agent 抢文件)。
 * 这个文件是 rotom 自家的"完整 rotom CLI 命令参考" — 跟 `src/shared/rotom-cli-prompt.ts`
 * 里的 [rotom CLI 使用规则] 段配对使用:prompt 段塞短 hint,agent 真要查命令时
 * 自己 `Read ~/.rotom/SKILL.md`。这样不依赖任何 provider 的 skill 机制。
 *
 * 在 rotom CLI 与 executor 两个入口都调用,保证只起 executor 不跑 rotom 时也能落盘。
 */
export function ensureRotomSkillMd(): void {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const skillSrc = path.join(here, "..", "..", "skill", "rotom-a2a-communicate", "SKILL.md");
    if (!fs.existsSync(skillSrc)) {
      return;
    }
    const content = fs.readFileSync(skillSrc, "utf-8");
    let needsWrite = true;
    if (fs.existsSync(ROTOM_SKILL_MD)) {
      try {
        const existing = fs.readFileSync(ROTOM_SKILL_MD, "utf-8");
        if (existing === content) needsWrite = false;
      } catch { /* 读失败 → 重写 */ }
    }
    if (needsWrite) {
      if (!fs.existsSync(ROTOM_HOME)) fs.mkdirSync(ROTOM_HOME, { recursive: true });
      fs.writeFileSync(ROTOM_SKILL_MD, content, "utf-8");
    }
  } catch (err: any) {
    process.stderr.write(`[rotom] WARN: failed to write ~/.rotom/SKILL.md: ${err.message}\n`);
  }
}
