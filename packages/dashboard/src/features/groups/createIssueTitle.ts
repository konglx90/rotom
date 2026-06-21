/**
 * Issue 创建表单的 title 预览工具。
 *
 * 后端 src/shared/title.ts 有完整实现,但 dashboard 是独立包无法跨包 import,
 * 这里复制一份精简版用于实时预览。截断规则必须与后端保持一致。
 */
export const TITLE_MAX_LENGTH = 40;

export function truncateTitle(content: string): string {
  const text = (content || '').trim().replace(/\s+/g, ' ');
  if (text.length <= TITLE_MAX_LENGTH) return text;
  const slice = text.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > TITLE_MAX_LENGTH * 0.5 ? slice.slice(0, lastSpace) : slice;
  return cut.trim() + '…';
}

/** 展示用 title —— 若 slash_command 为 /plan,剥掉开头前缀。 */
export function displayTitle(issue: {
  title: string;
  slash_command?: string | null;
}): string {
  if (issue.slash_command === '/plan' && issue.title.startsWith('/plan')) {
    return issue.title.slice('/plan'.length).trim() || issue.title;
  }
  return issue.title;
}

/** 展示用 description —— 若 slash_command 为 /plan 且 description 以 /plan 开头,剥掉前缀。 */
export function displayDescription(issue: {
  description: string;
  slash_command?: string | null;
}): string {
  const desc = issue.description || '';
  if (issue.slash_command === '/plan' && desc.startsWith('/plan')) {
    return desc.slice('/plan'.length).trim();
  }
  return desc;
}
