/**
 * Memory-extract prompt builder — extracted from api/issues.ts so the API
 * handler stays thin and the prompt text is testable in isolation.
 *
 * When the dashboard triggers "extract memory from this issue", the API
 * creates a child issue assigned to a chosen agent with this prompt as its
 * description. The agent reads the parent issue, distills 0..N memory
 * entries (fact / decision / convention / pitfall / todo / playbook), and
 * writes them via `rotom memory add ... --pending` for human review.
 */

interface SourceIssue {
  id: string;
  title: string;
  description: string | null | undefined;
  group_id: string;
}

/**
 * Build the Chinese prompt that instructs the agent to extract durable
 * memory entries from a finished issue.
 */
export function buildMemoryExtractPrompt(
  sourceIssue: SourceIssue,
  sourceShortId: string,
): string {
  return [
    `[记忆提取任务] 请从 Issue #${sourceShortId} 的产出中提炼值得长期记住的经验。`,
    ``,
    `原 Issue 标题:${sourceIssue.title}`,
    `原 Issue 描述:`,
    sourceIssue.description || "(无)",
    ``,
    `步骤:`,
    `1. 用 \`rotom issue show ${sourceIssue.id}\` 或读 issue 详情,了解这次任务做了什么、关键决策、踩过的坑、用到的技术栈/约定`,
    `2. 提炼 0~N 条记忆,每条选定 category(fact/decision/convention/pitfall/todo/playbook)`,
    `3. 每条用 \`rotom memory add ${sourceIssue.group_id} --key <主题> --value <内容> --category <cat> --summary <一句话> --pending\` 写入`,
    `   - --pending 必须加,写入后处于待审核状态,由人在 dashboard 审核`,
    `   - key 用 "decision:xxx" / "pitfall:xxx" / "fact:xxx" 等带前缀的形式`,
    `   - 只提炼真正值得长期记住的,无关细节不要记。没有值得记的就一条都不写`,
    `4. 完成后在群里回复"已提取 N 条记忆,待审核"`,
    ``,
    `重要:不要记临时性的、任务特定的、下次不会复用的信息。`,
  ].join("\n");
}
