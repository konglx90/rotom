/**
 * Prompt 组合器 —— 把"喂给 CLI agent 的 prompt"分层组装,每层标数据源。
 *
 * 拼接顺序:rotom-cli → agent-role → group-basic → cwd → task
 *  - rotom-cli: rotom CLI 使用规则(`ROTOM_CLI_PROMPT`),所有 agent 一致
 *  - agent-role: 来自 `agents.profile` JSON,per-agent
 *  - group-basic: 群上下文 + 活跃 issue 列表,群内所有 agent 一致
 *  - cwd: 工作目录只读头(如有 cwd)
 *  - task: chat 模式 = 用户原消息;issue 模式 = title + description;collab 模式 = 开场白
 *
 * 设计:这是**纯函数**,无 IO。worker 调它,拿到 ComposedPrompt 后:
 *  1. `prompt = composed.final` 喂给 executor
 *  2. `composed.layers` 经由 `a2a_reply_end` / `issue_update` 透传给 master 入库
 *  3. 前端点击消息 → 直接读库渲染,无需重算
 */

import { ROTOM_CLI_PROMPT, ROTOM_CLI_PROMPT_VERSION } from "./rotom-cli-prompt.js";
import type { AgentProfile } from "./agent-profile.js";
import type { ActiveIssueRef } from "./group-context.js";

export type PromptLayerKind = "rotom-cli" | "group-basic" | "agent-role" | "cwd" | "task";

export interface PromptLayer {
  layer: PromptLayerKind;
  content: string;
  /** 数据源标注,如 "src/shared/rotom-cli-prompt.ts (constant)" */
  source: string;
}

export interface ComposedPrompt {
  layers: PromptLayer[];
  final: string;
  generatedAt: string;
  promptVersion: string;
}

export interface ComposeContext {
  mode: "chat" | "issue" | "collab";
  agentName: string;
  agentProfile: AgentProfile | null;
  /** 群内调用时填;DM / 单 issue 可空 */
  group?: { id: string; name: string; activeIssues: ActiveIssueRef[] } | null;
  cwd: string | null;
  /** chat 模式时填,告诉 agent 这条消息是谁发的。issue/collab 模式不需要,留空。 */
  fromName?: string | null;
  /** chat 模式 = 用户原消息(已剥 @self);issue 模式 = title + "\n\n" + description;collab 模式 = 开场白 */
  body: string;
  /**
   * 工具调用审批策略(issue / collab 模式才用)。未传视为 'rw_allow' —— 与
   * master 端 normalizeApprovalPolicy 收敛口径一致。'r_allow' 下写盘需
   * dashboard 审批(agent 调 Write/Edit/写 Bash 时会被 PreToolUse hook
   * 挂住,等用户在 dashboard 上 Accept/Deny),'rw_allow' 写盘直接放行。
   */
  approvalPolicy?: "r_allow" | "rw_allow";
}

// ── Layer builders ──────────────────────────────────────────────────────

const SOURCE_ROTOM_CLI = "src/shared/rotom-cli-prompt.ts (constant)";
const SOURCE_AGENT_PROFILE = "agents.profile JSON (edit via Dashboard 员工介绍)";
const SOURCE_GROUP_BASIC = "groups + active_issues (runtime, from master enrichConversationWithCollaboration)";
const SOURCE_CWD = "<worker.executor>.resolveIssueCwd(groupId)";

function buildRotomCliLayer(): PromptLayer {
  return { layer: "rotom-cli", content: ROTOM_CLI_PROMPT, source: SOURCE_ROTOM_CLI };
}

function buildAgentRoleLayer(profile: AgentProfile | null): PromptLayer | null {
  if (!profile) return null;
  const fields: Array<[string, string | undefined]> = [
    ["category", profile.category],
    ["position", profile.position],
    ["bio", profile.bio],
  ];
  const present = fields.filter(([, v]) => typeof v === "string" && v.length > 0);
  if (present.length === 0) return null;
  const lines = ["[Agent 角色]", ...present.map(([k, v]) => `${k}: ${v}`)];
  return { layer: "agent-role", content: lines.join("\n") + "\n", source: SOURCE_AGENT_PROFILE };
}

function buildGroupBasicLayer(
  group: { id: string; name: string; activeIssues: ActiveIssueRef[] } | null | undefined,
  selfName: string,
): PromptLayer | null {
  if (!group) return null;

  const header =
    `[群消息 context: groupId=${group.id}, groupName="${group.name}", 你自己是="${selfName}"]\n`;

  const issuesBlock = renderActiveIssues(group.activeIssues);

  return {
    layer: "group-basic",
    content: header + issuesBlock,
    source: SOURCE_GROUP_BASIC,
  };
}

function renderActiveIssues(issues: ActiveIssueRef[] | undefined): string {
  const n = issues?.length ?? 0;
  const status = n === 0 ? "无" : `${n} 个进行中`;
  return `[当前群活跃 issue] ${status}\n`;
}

function buildCwdLayer(cwd: string | null, mode: ComposeContext["mode"], approvalPolicy?: "r_allow" | "rw_allow"): PromptLayer | null {
  if (!cwd) return null;
  // 写盘策略单行(详细话术见 SKILL.md 锚点):
  //   chat    → 只读,仅 Read/Grep/Glob/Bash(只读)
  //   rw_allow → 可写,Write/Edit/写 Bash 自动放行,无需 dashboard
  //   r_allow  → 可写,但写盘需 dashboard Accept/Deny;要免审批用 --approval-policy rw_allow
  const effectivePolicy: "r_allow" | "rw_allow" = approvalPolicy ?? "rw_allow";
  const writability =
    mode === "chat"
      ? `模式: chat(只读)。仅可 Read/Grep/Glob/Bash(只读);要写盘见 SKILL.md#写盘兜底话术。\n`
      : effectivePolicy === "rw_allow"
        ? `模式: ${mode},可写(rw_allow)。Write/Edit/写 Bash 自动放行,无需 dashboard 确认;只写本任务相关产出。\n`
        : `模式: ${mode},可写(r_allow)。写盘类(Write/Edit/写 Bash)会被挂起等 dashboard Accept/Deny;只读 Bash(ls/cat/grep/git status/git diff/git log/rotom status 等)自动放行不打扰;要完全免审批用 --approval-policy rw_allow。\n`;
  return {
    layer: "cwd",
    content:
      `[artifacts目录] ${cwd}\n` +
      `相对路径基于此目录解析;Read/Grep/Glob 用相对路径即可,不要 \`cd\` 切到其他目录。\n` +
      writability,
    source: SOURCE_CWD,
  };
}

function buildTaskLayer(body: string, mode: ComposeContext["mode"], fromName?: string | null): PromptLayer {
  let source: string;
  let content: string;
  switch (mode) {
    case "chat":
      source = "user message (GroupChatView.handleSendMessage → ws a2a_send.payload.message)";
      content = fromName ? `[from=${fromName}]\n${body}` : body;
      break;
    case "issue":
      source = "issues.title + issues.description (db.ts:executeIssue)";
      content = body;
      break;
    case "collab":
      source = "handleCollaborationStarted inline template (worker.ts:757-771)";
      content = body;
      break;
  }
  return { layer: "task", content, source };
}

// ── Public API ──────────────────────────────────────────────────────────

export function composePrompt(ctx: ComposeContext): ComposedPrompt {
  const layers: PromptLayer[] = [];
  // Issue 模式的 prompt 不含 rotom CLI 使用规则:agent 直接执行任务描述,
  // 不需要 rotom CLI 语法心智负担。该规则对群聊(chat)和协作(collab)仍保留。
  if (ctx.mode !== "issue") {
    layers.push(buildRotomCliLayer());
  }

  const role = buildAgentRoleLayer(ctx.agentProfile);
  if (role) layers.push(role);

  const group = buildGroupBasicLayer(ctx.group, ctx.agentName);
  if (group) layers.push(group);

  const cwd = buildCwdLayer(ctx.cwd, ctx.mode, ctx.approvalPolicy);
  if (cwd) layers.push(cwd);

  // chat 模式下,发信人 fromName 注入到 task 层头部(只有 chat 才有 fromName 语义)。
  layers.push(buildTaskLayer(ctx.body, ctx.mode, ctx.mode === "chat" ? ctx.fromName : null));

  return {
    layers,
    final: layers.map((l) => l.content).join("\n"),
    generatedAt: new Date().toISOString(),
    promptVersion: ROTOM_CLI_PROMPT_VERSION,
  };
}
