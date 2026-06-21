/**
 * Issue title 自动生成与展示工具。
 *
 * 设计：合并 title/description 后,用户只填一个内容字段(description)。
 * title 从 description 前 N 字符截断生成,用于列表、详情 header 等紧凑展示。
 * 若 description 以 `/plan` 开头,截断后的 title 保留 `/plan` 前缀以便
 * parseSlashCommand 解析;展示侧用 displayTitle 剥掉前缀避免污染。
 */

export const TITLE_MAX_LENGTH = 40;

/**
 * 从内容截断生成 title。
 * - 折叠空白为单空格
 * - 超长时优先在最后一个空格处截断,避免词中间断开
 * - 截断后追加 …
 */
export function truncateTitle(content: string): string {
  const text = (content || "").trim().replace(/\s+/g, " ");
  if (text.length <= TITLE_MAX_LENGTH) return text;
  const slice = text.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > TITLE_MAX_LENGTH * 0.5 ? slice.slice(0, lastSpace) : slice;
  return cut.trim() + "…";
}

/**
 * 展示用 title —— 若 slash_command 为 /plan,剥掉 title 开头的 `/plan ` 前缀。
 * 列表已有 plan 徽标,title 本体无需重复暴露元信息。
 */
export function displayTitle(issue: {
  title: string;
  slash_command?: string | null;
}): string {
  if (issue.slash_command === "/plan" && issue.title.startsWith("/plan")) {
    return issue.title.slice("/plan".length).trim() || issue.title;
  }
  return issue.title;
}

/**
 * 展示用 description —— 若 slash_command 为 /plan 且 description 以 /plan 开头,
 * 剥掉前缀,避免元信息污染正文。
 */
export function displayDescription(issue: {
  description: string;
  slash_command?: string | null;
}): string {
  const desc = issue.description || "";
  if (
    issue.slash_command === "/plan" &&
    desc.startsWith("/plan")
  ) {
    return desc.slice("/plan".length).trim();
  }
  return desc;
}
