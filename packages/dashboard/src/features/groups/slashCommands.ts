import type { Issue, Note, Schedule } from '../../api/types'
import { issuesApi } from '../../api/issues'
import { schedulesApi } from '../../api/schedules'
import { notesApi } from '../../api/notes'

export type SlashListKind = 'issue' | 'schedule' | 'note'

export type SlashListData =
  | { kind: 'issue'; items: Issue[] }
  | { kind: 'schedule'; items: Schedule[] }
  | { kind: 'note'; items: Note[] }

export interface SlashCommandContext {
  groupId: string
  agentName: string
  showList: (data: SlashListData) => void
  flashToast: (msg: string, kind?: 'info' | 'error') => void
}

export interface SlashCommandSpec {
  name: string
  description: string
  argHint?: string
  requiresArg: boolean
  run: (args: string, ctx: SlashCommandContext) => Promise<void> | void
}

const LIST_LIMIT = 20

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: 'issue',
    description: '查看当前群组的 issue 列表(最近 20 条)',
    requiresArg: false,
    run: async (_args, ctx) => {
      try {
        const items = await issuesApi.listByGroup(ctx.groupId)
        ctx.showList({ kind: 'issue', items: items.slice(0, LIST_LIMIT) })
      } catch (e) {
        ctx.flashToast(`加载 issue 失败: ${(e as Error).message}`, 'error')
      }
    },
  },
  {
    name: 'issue-create',
    description: '直接创建一条 issue(用文本作 description,未指派)',
    argHint: '<title>',
    requiresArg: true,
    run: async (args, ctx) => {
      const title = args.trim()
      if (!title) {
        ctx.flashToast('用法: /issue-create <title>', 'error')
        return
      }
      try {
        const res = await issuesApi.create(ctx.groupId, {
          description: title,
          createdBy: ctx.agentName,
        })
        ctx.flashToast(`已创建 issue #${res.id}`)
      } catch (e) {
        ctx.flashToast(`创建 issue 失败: ${(e as Error).message}`, 'error')
      }
    },
  },
  {
    name: 'schedule',
    description: '查看当前群组的定时任务列表',
    requiresArg: false,
    run: async (_args, ctx) => {
      try {
        const items = await schedulesApi.listByGroup(ctx.groupId)
        ctx.showList({ kind: 'schedule', items })
      } catch (e) {
        ctx.flashToast(`加载 schedule 失败: ${(e as Error).message}`, 'error')
      }
    },
  },
  {
    name: 'schedule-create',
    description: '60s 后一次性触发一条定时消息(默认值,可后续在面板里改)',
    argHint: '<name> <prompt>',
    requiresArg: true,
    run: async (args, ctx) => {
      const trimmed = args.trim()
      const sep = trimmed.indexOf(' ')
      if (sep <= 0) {
        ctx.flashToast('用法: /schedule-create <name> <prompt>', 'error')
        return
      }
      const name = trimmed.slice(0, sep).trim()
      const prompt = trimmed.slice(sep + 1).trim()
      if (!name || !prompt) {
        ctx.flashToast('用法: /schedule-create <name> <prompt>', 'error')
        return
      }
      try {
        await schedulesApi.create({
          name,
          group_id: ctx.groupId,
          mode: 'message',
          schedule_kind: 'once',
          run_at: Date.now() + 60_000,
          prompt,
          enabled: true,
        })
        ctx.flashToast(`已创建定时任务 ${name}`)
      } catch (e) {
        ctx.flashToast(`创建 schedule 失败: ${(e as Error).message}`, 'error')
      }
    },
  },
  {
    name: 'note',
    description: '查看当前群组的 note 列表',
    requiresArg: false,
    run: async (_args, ctx) => {
      try {
        const items = await notesApi.listByGroup(ctx.groupId)
        ctx.showList({ kind: 'note', items })
      } catch (e) {
        ctx.flashToast(`加载 note 失败: ${(e as Error).message}`, 'error')
      }
    },
  },
  {
    name: 'note-create',
    description: '快速落库一条 note(文本作 title,无 description)',
    argHint: '<text>',
    requiresArg: true,
    run: async (args, ctx) => {
      const title = args.trim()
      if (!title) {
        ctx.flashToast('用法: /note-create <text>', 'error')
        return
      }
      try {
        await notesApi.create(ctx.groupId, {
          title,
          createdBy: ctx.agentName,
        })
        ctx.flashToast('已创建 note')
      } catch (e) {
        ctx.flashToast(`创建 note 失败: ${(e as Error).message}`, 'error')
      }
    },
  },
]

export function filterSlashCommands(filter: string): SlashCommandSpec[] {
  if (!filter) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter(c => c.name.startsWith(filter))
}

export function findSlashCommand(name: string): SlashCommandSpec | undefined {
  return SLASH_COMMANDS.find(c => c.name === name)
}
