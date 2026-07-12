// GroupChatView 的主面板布局常量与 localStorage 读取。
// 三类顶级 panel(chat / process / artifact)固定 3 种同屏组合模式。
// 从 GroupChatView.tsx 抽出,纯常量 + 两个 reader,无 React。
import type { PanelConfig } from './_hooks/useResizablePanels'

// 主面板布局:三类顶级 panel —— chat / process / artifact。
//   - chat: 对话区
//   - process: 过程区,内部 sub-tab 切 Issues/Notes/定时任务(Issues 为主)
//   - artifact: 产物区
//
// 显示规则:固定 3 种组合模式,toolbar 切换,确保主区始终 2 个 panel 同屏。
//   - chat+process(默认):对话 + 过程
//   - chat+artifact:对话 + 产物
//   - process+artifact:过程 + 产物
export type PanelId = 'chat' | 'process' | 'artifact'
export type PanelMode = 'chat-process' | 'chat-artifact' | 'process-artifact'
export type ProcessTab = 'issues' | 'notes' | 'schedules'

export const PANEL_ORDER: PanelId[] = ['chat', 'process', 'artifact']
export const MODE_PANELS: Record<PanelMode, PanelId[]> = {
  'chat-process': ['chat', 'process'],
  'chat-artifact': ['chat', 'artifact'],
  'process-artifact': ['process', 'artifact'],
}
export const PANEL_CONFIGS: PanelConfig[] = [
  { id: 'chat', width: 720, min: 360 },
  { id: 'process', width: 480, min: 320 },
  { id: 'artifact', width: 560, min: 360 },
]
export const PANEL_MIN_BY_ID: Record<string, number> = Object.fromEntries(
  PANEL_CONFIGS.map((c) => [c.id, c.min]),
)
export const PANEL_MODE_KEY = 'rotom-panel-mode'
export const PROCESS_TAB_KEY = 'rotom-process-tab'

export function loadPanelMode(): PanelMode {
  try {
    const raw = localStorage.getItem(PANEL_MODE_KEY)
    if (raw === 'chat-process' || raw === 'chat-artifact' || raw === 'process-artifact') return raw
    return 'chat-process'
  } catch {
    return 'chat-process'
  }
}

export function loadProcessTab(): ProcessTab {
  try {
    const raw = localStorage.getItem(PROCESS_TAB_KEY)
    if (raw === 'issues' || raw === 'notes' || raw === 'schedules') return raw
    return 'issues'
  } catch {
    return 'issues'
  }
}
