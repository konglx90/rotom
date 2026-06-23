/**
 * rotom CLI 使用规则 — 注入到每一个 CLI agent prompt 的最前段。
 *
 * 设计要点:
 * - 这是一段**短**的 meta 信息(不是 skill description),与所有 agent 看到的都一致。
 * - 完整命令参考放在 `~/.rotom/SKILL.md`,由 rotom CLI 启动时把
 *   `skill/rotom-a2a-communicate/SKILL.md` 内联写入。Agent 需要时自行 Read。
 *   提示里只放一句"去看 SKILL.md"+ 锚点名,不重复列命令清单。
 * - 不同 provider (claude/codex/openclaw/hermes/generic) 各自的
 *   "skill 机制位置" 不一致 —— 因此 rotom 自己做一份"自家文档"放在约定路径,
 *   不依赖任何 provider 的 skill 系统。
 */

export const ROTOM_CLI_PROMPT_VERSION = "rotomCliPrompt@2026-06-23a";

export const ROTOM_CLI_PROMPT = `[rotom CLI 使用规则]
通过 Bash 调 \`rotom\` 操作 Mesh;详细见 ~/.rotom/SKILL.md,按需 Read(命令清单 / 行动判定 / 故障排查)。
- 默认 JSON 输出(加 --pretty 看表格),命令自动用当前 agent 身份,**不要传 --as**。
- **写盘前必须有 in_progress issue**;活跃 issue 数见下 [当前群活跃 issue]。

错误速查(stderr 第一行即可判断):
- HTTP 4xx → 命令参数错,改参数重试
- HTTP 5xx → master 异常,重试 1-2 次
- network error → 网络失败,先 \`rotom status\` 自检
- interrupted → master 已收但 body 截断,**非幂等别盲重试**

反模式:rotom 命令不要加 \`|| echo "X failed"\` 兜底——直接 stderr 透传,exit≠0 先 \`rotom status\`。
`;
