const STORAGE_KEY = 'chat_input_history_v1'
const MAX_ENTRIES = 200

export function getHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((s): s is string => typeof s === 'string')
  } catch {
    return []
  }
}

export function pushHistory(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const history = getHistory()
  if (history[history.length - 1] === trimmed) return
  history.push(trimmed)
  while (history.length > MAX_ENTRIES) history.shift()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch {
    // localStorage 可能因配额/隐私模式失败，静默忽略
  }
}
