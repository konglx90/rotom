/**
 * 占位符工具 —— 把模板里的 {{key}} 替换成 vars[key]。
 * 用于群指导模板的 prompt_text 和 schedule_config 里的 agent_name / prompt。
 *
 * 未提供值的占位符保留原样(不替换),让用户在 textarea 里能看见,自行改。
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** 扫描文本里出现的所有占位符 key,按出现顺序去重返回。 */
export function extractPlaceholders(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    const key = m[1]
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/** 把 {{key}} 替换成 vars[key];vars 里没有的 key 保留原样。 */
export function resolvePlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== ''
      ? vars[key]
      : full
  })
}
