/**
 * Issue slash command 白名单与解析。
 *
 * 设计：master 在 POST /groups/:groupId/issues 时调 parseSlashCommand(title)
 * 解析首个 token；若命中 SLASH_COMMAND_REGISTRY 则写入 issues.slash_command。
 * worker 收到 issue_assigned 后据此向底层 CLI 注入对应执行模式。
 */

export type SlashBackend = "claude" | "codex";

export interface SlashCommandSpec {
  name: string;
  backends: SlashBackend[];
  description: string;
}

export const SLASH_COMMAND_REGISTRY: Record<string, SlashCommandSpec> = {
  "/plan": {
    name: "/plan",
    backends: ["claude", "codex"],
    description: "以计划模式执行：先输出方案，等待用户审批后才落盘",
  },
};

/**
 * 解析 title 首个 token。仅当 token 形如 /[a-z][a-z0-9-]* 才视为 slash command
 * 候选；其他形如 "/path/to" 之类的不会被误判。
 *
 * - 命中注册表 → 返回 { command, stripped }。
 * - 匹配前缀模式但未注册 → 返回 { command, stripped, unknown:true } 由调用方决定如何处理。
 * - 完全不匹配 → 返回 null。
 */
export function parseSlashCommand(title: string): {
  command: string;
  stripped: string;
  known: boolean;
} | null {
  if (!title) return null;
  const m = title.match(/^(\/[a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = m[1];
  const stripped = (m[2] || "").trim();
  return {
    command,
    stripped,
    known: Object.prototype.hasOwnProperty.call(SLASH_COMMAND_REGISTRY, command),
  };
}

/**
 * 给 Codex 用的 plan 模式 developerInstructions。Codex 没有原生 plan 模式，
 * 通过开发者系统指令引导其"先方案后落盘"。
 */
export function buildPlanModeInstruction(): string {
  return [
    "[plan-mode]",
    "你当前处于「计划模式」执行任务。规则：",
    "1. 先彻底理解需求并探索代码（只允许读操作：阅读文件、grep、列目录）。",
    "2. 把方案以清晰的 Markdown 输出（包含：背景、改动文件清单、关键步骤、风险/回退、验证方式）。",
    "3. 输出方案后立即停下，等待用户审批确认；未经确认不要执行任何写操作（写文件、改配置、跑构建/迁移、提交、推送等）。",
    "4. 用户确认后再开始实现；用户驳回则根据反馈调整方案再次输出。",
  ].join("\n");
}
