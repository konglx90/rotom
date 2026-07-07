/**
 * 本机已安装 CLI 的探测 —— executor (scanClis 模式) 和 CLI (resolveAgent 兜底) 共用,
 * 避免两份 `which` 列表漂移。
 */

import { execSync } from "node:child_process";

/** 已知 CLI 集合;scanClis 模式按此列表探测。 */
export const ALL_KNOWN_CLIS = ["claude", "openclaw", "codex", "hermes", "pi"];

/** detectCliTool 的默认优先级(单 worker 兜底用)。 */
export const CLI_PRIORITY = ["claude", "openclaw", "codex", "pi"];

/**
 * 扫描本机已安装的 CLI,返回数组。OPC 模式下若无 executor.config.json,
 * 为每个已安装的 CLI 自动注册一个 agent(name 默认 = CLI 名,可通过后续
 * 配置覆盖)。这是"每台机器 = 一个真人 + 多个 CLI agent"语义的关键。
 */
export function detectInstalledClis(): string[] {
  const found: string[] = [];
  for (const tool of ALL_KNOWN_CLIS) {
    try {
      execSync(`which ${tool}`, { stdio: "pipe" });
      found.push(tool);
    } catch { /* not installed */ }
  }
  return found;
}

/**
 * 探测单个 CLI 是否已安装。resolveAgent 的 .auto-executor.json 兜底用它。
 */
export function isCliInstalled(tool: string): boolean {
  try {
    execSync(`which ${tool}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 按优先级挑一个已安装的 CLI,默认返回 "claude"(向后兼容旧 detectCliTool)。
 */
export function detectCliTool(): string {
  for (const tool of CLI_PRIORITY) {
    if (isCliInstalled(tool)) return tool;
  }
  return "claude";
}
