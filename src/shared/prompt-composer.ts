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
}

// ── Layer builders ──────────────────────────────────────────────────────

const SOURCE_ROTOM_CLI = "src/shared/rotom-cli-prompt.ts (constant)";
const SOURCE_AGENT_PROFILE_NULL = "agents.profile = null";
const SOURCE_AGENT_PROFILE = "agents.profile JSON (edit via rotom agent profile set)";
const SOURCE_GROUP_BASIC = "groups + active_issues (runtime, from master enrichConversationWithCollaboration)";
const SOURCE_CWD = "<worker.executor>.resolveIssueCwd(groupId)";

function buildRotomCliLayer(): PromptLayer {
  return { layer: "rotom-cli", content: ROTOM_CLI_PROMPT, source: SOURCE_ROTOM_CLI };
}

function buildAgentRoleLayer(profile: AgentProfile | null): PromptLayer | null {
  if (!profile) {
    return {
      layer: "agent-role",
      content: "[Agent 角色]\n(无 profile —— agents.profile 为空)\n",
      source: SOURCE_AGENT_PROFILE_NULL,
    };
  }
  const lines = [
    "[Agent 角色]",
    `category: ${profile.category ?? "(未填)"}`,
    `position: ${profile.position ?? "(未填)"}`,
    `responsibilities: ${profile.responsibilities ?? "(未填)"}`,
    `tech_stack: ${profile.tech_stack ?? "(未填)"}`,
  ];
  return { layer: "agent-role", content: lines.join("\n") + "\n", source: SOURCE_AGENT_PROFILE };
}

function buildGroupBasicLayer(
  group: { id: string; name: string; activeIssues: ActiveIssueRef[] } | null | undefined,
  selfName: string,
  fromName?: string | null,
): PromptLayer | null {
  if (!group) return null;

  const fromClause = fromName ? `, 发信人是="${fromName}"` : "";
  const header =
    `[群消息 context: groupId=${group.id}, groupName="${group.name}", ` +
    `你自己是="${selfName}"${fromClause}。` +
    `重要：如果 @ 的是你自己（"${selfName}"），那就是在叫你回答，直接回答即可，` +
    `不要再调用发送消息给自己。]\n`;

  const issuesBlock = renderActiveIssues(group.activeIssues);

  return {
    layer: "group-basic",
    content: header + issuesBlock,
    source: SOURCE_GROUP_BASIC,
  };
}

function renderActiveIssues(issues: ActiveIssueRef[] | undefined): string {
  if (!issues || issues.length === 0) {
    return (
      `[当前群活跃 issue]\n` +
      `无\n` +
      `提示：本群当前没有进行中的 issue。如需修改文件，请先 \`rotom issue create\` 建任务承载，否则只允许 Read/Grep/Glob。\n`
    );
  }
  const lines = issues.map((it) => {
    const id = it.id.slice(0, 8);
    const owner = it.assignedTo ? ` by ${it.assignedTo}` : " 未认领";
    const prio = it.priority ? ` [${it.priority}]` : "";
    return `- #${id}  ${it.status}${prio}  "${it.title}"${owner}`;
  });
  return (
    `[当前群活跃 issue]\n` +
    lines.join("\n") + "\n" +
    `提示：涉及文件改动请关联以上某个 issue;若无匹配的,先 \`rotom issue create\` 新建,确认 in_progress 后再写盘。\n`
  );
}

function buildCwdLayer(cwd: string | null): PromptLayer | null {
  if (!cwd) return null;
  return {
    layer: "cwd",
    content:
      `[工作目录] ${cwd}\n` +
      `所有相对路径基于此目录解析；spawn 的子进程 cwd 已设置在这里，` +
      `Read/Grep/Glob 直接用相对路径即可，不要用 \`cd\` 切换到其他目录。\n` +
      `**重要：此目录为只读，agent 仅可 Read/Grep/Glob/Bash（只读命令），不得调用 Write/Edit 等写盘工具。**\n` +
      `需要持久化的产出请通过 issue 评论 / artifact 工具回传 master，或用 Bash 写到非 workingDir 的沙箱目录。\n`,
    source: SOURCE_CWD,
  };
}

function buildTaskLayer(body: string, mode: ComposeContext["mode"]): PromptLayer {
  let source: string;
  switch (mode) {
    case "chat":
      source = "user message (GroupChatView.handleSendMessage → ws a2a_send.payload.message)";
      break;
    case "issue":
      source = "issues.title + issues.description (db.ts:executeIssue)";
      break;
    case "collab":
      source = "handleCollaborationStarted inline template (worker.ts:757-771)";
      break;
  }
  return { layer: "task", content: body, source };
}

// ── Public API ──────────────────────────────────────────────────────────

export function composePrompt(ctx: ComposeContext): ComposedPrompt {
  const layers: PromptLayer[] = [];
  layers.push(buildRotomCliLayer());

  const role = buildAgentRoleLayer(ctx.agentProfile);
  if (role) layers.push(role);

  const group = buildGroupBasicLayer(ctx.group, ctx.agentName, ctx.fromName);
  if (group) layers.push(group);

  const cwd = buildCwdLayer(ctx.cwd);
  if (cwd) layers.push(cwd);

  layers.push(buildTaskLayer(ctx.body, ctx.mode));

  return {
    layers,
    final: layers.map((l) => l.content).join("\n"),
    generatedAt: new Date().toISOString(),
    promptVersion: ROTOM_CLI_PROMPT_VERSION,
  };
}
