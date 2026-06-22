/**
 * rotom CLI 使用规则 — 注入到每一个 CLI agent prompt 的最前段。
 *
 * 设计要点:
 * - 这是一段**短**的 meta 信息(不是 skill description),与所有 agent 看到的都一致。
 * - 完整命令参考放在 `~/.rotom/SKILL.md`,由 rotom CLI 启动时把
 *   `skill/rotom-a2a-communicate/SKILL.md` 内联写入。Agent 需要时自行 Read。
 * - 不同 provider (claude/codex/openclaw/hermes/generic) 各自的
 *   "skill 机制位置" 不一致 —— 因此 rotom 自己做一份"自家文档"放在约定路径,
 *   不依赖任何 provider 的 skill 系统。
 */

export const ROTOM_CLI_PROMPT_VERSION = "rotomCliPrompt@2026-06-17d";

export const ROTOM_CLI_PROMPT = `[rotom CLI 使用规则]
在 rotom Mesh 网络里，通过 Bash 调用全局 \`rotom\` 命令完成所有操作（发消息、建 issue、协作）。
- \`rotom\` 默认 JSON 输出（加 \`--pretty\` 看表格）；命令自动用当前 agent 身份，**不要传 \`--as\`**。
- 命令清单见 \`~/.rotom/SKILL.md\`（写盘 / 查历史 / 建 issue / 协作 / 建 note等，需要时 Read 查看）。
- **写盘必须先有 \`in_progress\` issue**；看上方 [当前群活跃 issue] 段判断。
- 快速落代码：\`rotom issue create <groupId> --title T --description D --assignee <self> --run --approval-policy rw_allow\`，一步到位。**占位/模板/简单示例直接落，不要反问用户"想要什么"或"走 A/B"。**

错误解读（stderr 第一行即可判断）：
- \`rotom: command failed: HTTP 4xx ...\` → 命令参数错，master 正常，修命令重试。
- \`rotom: command failed: HTTP 5xx ...\` → master 异常，重试 1-2 次。
- \`rotom: network error ...\` → 网络失败（连接拒/socket reset/DNS）；先 \`rotom status\` 自检，再查 master log。
- \`rotom: response from master was interrupted ...\` → master 几乎收到了请求，body 被截断。**非幂等操作不要盲目重试**，先查 master log。
- 不确定时先 \`rotom status\`，**不要凭 stderr 前缀猜系统状态**。

反模式：不要给 rotom 命令加 \`|| echo "X failed"\` 兜底。\`exit 1\` 都会触发 \`||\`，echo 会误导你自己。直接跑命令让原生 stderr 透传，非零 exit 时先 \`rotom status\`。
`;
