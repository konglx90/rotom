/**
 * Group context prompt injection — shared by InboundDispatcher and ExecutorWorker.
 *
 * Prepends group metadata (groupId, groupName, selfName) to the prompt so that
 * any CLI-backed agent knows which group it is responding in.
 */

export interface ActiveIssueRef {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  priority?: string;
}

export interface GroupConversation {
  type?: string;
  groupId?: string;
  groupName?: string;
  activeIssues?: ActiveIssueRef[];
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

/**
 * If `conversation` represents a group chat, return the prompt wrapped with
 * group-context metadata; otherwise return the prompt unchanged.
 */
export function injectGroupContext(
  prompt: string,
  conversation: GroupConversation | undefined | null,
  selfName: string,
): string {
  const isGroup = conversation?.type === "group" && !!conversation.groupId;
  if (!isGroup) return prompt;

  const groupId = conversation!.groupId!;
  const groupName = conversation!.groupName || groupId;

  const header =
    `[群消息 context: groupId=${groupId}, groupName="${groupName}", ` +
    `你自己是="${selfName}"。` +
    `重要：如果 @ 的是你自己（"${selfName}"），那就是在叫你回答，直接回答即可，` +
    `不要再调用发送消息给自己。]\n`;

  const issuesBlock = renderActiveIssues(conversation!.activeIssues);

  return `${header}${issuesBlock}\n${prompt}`;
}

/**
 * Prefix the prompt with the working directory so CLI agents resolve paths
 * (`src/foo.ts` etc.) consistently with the cwd we pass to spawn(). The
 * spawn cwd alone is invisible to the model — it only sees the prompt text.
 *
 * No-op when cwd is empty (e.g. fallback to executor default).
 *
 * Read-only semantics: the working directory is a **read-only** mount for the
 * agent. The agent may Read / Grep / Glob / Bash (read-only commands) but
 * must NOT call Write / Edit or any other disk-mutating tool on paths under
 * this directory. Cross-machine deployments enforce this so each executor
 * machine's local FS doesn't diverge.
 */
export function prependWorkingDir(
  prompt: string,
  cwd: string | undefined | null,
): string {
  if (!cwd) return prompt;
  return (
    `[工作目录] ${cwd}\n` +
    `所有相对路径基于此目录解析；spawn 的子进程 cwd 已设置在这里，` +
    `Read/Grep/Glob 直接用相对路径即可，不要用 \`cd\` 切换到其他目录。\n` +
    `**重要：此目录为只读，agent 仅可 Read/Grep/Glob/Bash（只读命令），不得调用 Write/Edit 等写盘工具。**\n` +
    `需要持久化的产出请通过 issue 评论 / artifact 工具回传 master，或用 Bash 写到非 workingDir 的沙箱目录。\n\n` +
    prompt
  );
}
