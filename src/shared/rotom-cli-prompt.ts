/**
 * rotom CLI 使用规则 — 注入到每一个 CLI agent prompt 的最前段。
 *
 * 设计要点:
 * - 这是一段**短**的 meta 信息(不是 skill description),与所有 agent 看到的都一致。
 * - 完整命令参考放在 `~/.rotom/SKILL.md`,由 rotom CLI 启动时把
 *   `skill/rotom-a2a-communicate/SKILL.md` 内联写入。Agent 需要时自行 Read。
 *   提示里只放一句"去看 SKILL.md"+ 锚点名,不重复列命令清单。
 * - 不同 provider (claude/codex/hermes/generic) 各自的
 *   "skill 机制位置" 不一致 —— 因此 rotom 自己做一份"自家文档"放在约定路径,
 *   不依赖任何 provider 的 skill 系统。
 */

export const ROTOM_CLI_PROMPT_VERSION = "rotomCliPrompt@2026-07-10a";

export const ROTOM_CLI_PROMPT = `[rotom CLI]
通过 Bash 调 \`rotom\`(身份自动,不要传 --as;详情 Read ~/.rotom/SKILL.md)。
- 群里是只读的:改文件或多步任务别在群里干——建 issue \`rotom issue create <gid> --assignee 你自己 --run\` 切到可写路径(见 SKILL.md#写盘兜底话术);一句话能答/纯查可直接回。严禁建空 issue 只为走开始/完成状态。
- **你的回复正文就是群消息**——写什么群里就显示什么。提问其他 agent 时直接在正文里写 \`@对方 <问题> #reply\`,**不要调 \`rotom group send\`**。系统检测到 #reply 自动起 5min 超时 timer。
- **被其他 agent 提问时,回复正文以 @提问者 开头**(例:\`@西花-claude 回复内容...\`)。
- 收到 [ask-bridge 复述] 系统消息后:对方没 @ 你但系统检测到回复了,基于复述继续任务。
- 普通 @ (不带 #reply) 不起 timer,只是提到对方。
- **要 @ 人前不知道群里谁是谁 / 各自岗位,调 \`rotom group members <groupId>\` 查**(返回 position / bio / category / status);按岗位匹配目标,不要按名字猜。
- exit≠0 看 stderr 第一行,先 \`rotom status\` 自检。
`;
