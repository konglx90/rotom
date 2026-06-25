import type { TodoItem } from '../../../api/types'
import styles from './WorkerTodosPanel.module.css'

interface WorkerTodosPanelProps {
  todos: TodoItem[]
  agentName: string
  /** Issue 是否仍在进行中(in_progress / paused)。决定折叠规则:
   *  - 进行中:即使所有 todo 都 completed,仍然展开显示(让用户看到「刚完成」的状态)
   *  - 终态:全 completed 时折叠,避免占空间 */
  active: boolean
}

const STATUS_LABEL: Record<TodoItem['status'], string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '已完成',
}

/**
 * Worker Todo 列表面板 —— 数据来源是 issue.latest_todos(master 在每次
 * TodoWrite 时覆盖式写入)。三态用 Wise 风格 pill badge 区分:
 *   completed   → Wise Green 背景 + Dark Green 文字
 *   in_progress → Bright Orange 背景 + Near Black 文字
 *   pending     → Light Surface 背景 + Warm Dark 文字
 *
 * 折叠规则见 WorkerTodosPanelProps.active。空列表由父组件保证不渲染。
 */
export function WorkerTodosPanel({ todos, agentName, active }: WorkerTodosPanelProps) {
  if (todos.length === 0) return null

  const counts = todos.reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc },
    {} as Record<TodoItem['status'], number>,
  )
  const completed = counts.completed ?? 0
  const inProgress = counts.in_progress ?? 0
  const pending = counts.pending ?? 0

  // 终态 + 全 completed → 折叠(任务收尾后不再常驻展示)
  if (!active && completed === todos.length) return null

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>📋 {agentName ? `${agentName} 的 Todo` : 'Todo 列表'}</span>
        <span className={styles.summary}>
          {completed} 完成 · {inProgress} 进行 · {pending} 待办
        </span>
      </div>
      <ul className={styles.list}>
        {todos.map((todo, idx) => (
          <li key={idx} className={`${styles.item} ${statusClass(todo.status)}`}>
            <span className={styles.badge}>{STATUS_LABEL[todo.status]}</span>
            <span className={styles.text}>{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function statusClass(status: TodoItem['status']): string {
  if (status === 'completed') return styles.completed
  if (status === 'in_progress') return styles.inProgress
  return styles.pending
}
