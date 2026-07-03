/**
 * 工具箱页面 —— 把低频观察类页面(终端/消息流)和配置类页面(Prompt管理/
 * 定时任务模板管理)收敛到一个一级入口,左侧分组导航 + 右侧内容。
 */

import { NavLink, Outlet } from 'react-router-dom'
import styles from './ToolboxView.module.css'

interface TabItem {
  to: string
  label: string
  icon: string
  desc?: string
}

interface TabGroup {
  title: string
  items: TabItem[]
}

const TAB_GROUPS: TabGroup[] = [
  {
    title: '观察 & 监控',
    items: [
      { to: 'messages', label: '消息流', icon: '📜', desc: 'A2A 消息日志' },
      { to: 'issue-patrol', label: 'Issue 巡检', icon: '🔍', desc: '定时巡检任务' },
      { to: 'link-patrol', label: 'Link 分类', icon: '🔗', desc: '链接智能分类巡检' },
      { to: 'terminal', label: '终端', icon: '⌨️', desc: '执行器终端' },
    ],
  },
  {
    title: '资产 & 配置',
    items: [
      { to: 'prompts', label: 'Prompt 管理', icon: '📝', desc: '指导模板' },
      { to: 'schedule-patterns', label: '定时任务模板', icon: '⏰', desc: '调度模板' },
      { to: 'memory', label: '记忆', icon: '🧠', desc: '长期记忆' },
      { to: 'skills', label: '技能', icon: '⚡', desc: '技能包' },
    ],
  },
  {
    title: '资源',
    items: [
      { to: 'gallery', label: '图册', icon: '🖼️', desc: '图片素材' },
      { to: 'worktrees', label: 'Worktrees', icon: '🌿', desc: 'Git 仓库 & worktree' },
    ],
  },
]

export function ToolboxView() {
  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarHeaderIcon}>🧰</span>
          <span className={styles.sidebarHeaderText}>工具箱</span>
        </div>
        <nav className={styles.nav}>
          {TAB_GROUPS.map((group) => (
            <div key={group.title} className={styles.navGroup}>
              <div className={styles.navGroupTitle}>{group.title}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                  }
                >
                  <span className={styles.navItemIcon}>{item.icon}</span>
                  <span className={styles.navItemBody}>
                    <span className={styles.navItemLabel}>{item.label}</span>
                    {item.desc && (
                      <span className={styles.navItemDesc}>{item.desc}</span>
                    )}
                  </span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className={styles.body}>
        <Outlet />
      </div>
    </div>
  )
}
