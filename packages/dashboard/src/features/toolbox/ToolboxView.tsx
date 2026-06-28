/**
 * 工具箱页面 —— 把低频观察类页面(终端/消息流)和配置类页面(Prompt管理/
 * 定时任务模板管理)收敛到一个一级入口,顶部 Tab 切换。子路由对应各 Tab,
 * 便于分享链接和浏览器前进/后退。
 */

import { NavLink, Outlet } from 'react-router-dom'
import styles from './ToolboxView.module.css'

const TABS = [
  { to: 'messages', label: '消息流', icon: '📜' },
  { to: 'terminal', label: '终端', icon: '⌨️' },
  { to: 'prompts', label: 'Prompt管理', icon: '📝' },
  { to: 'schedule-patterns', label: '定时任务模板管理', icon: '⏰' },
] as const

export function ToolboxView() {
  return (
    <div className={styles.page}>
      <nav className={styles.tabs}>
        {TABS.map(t => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              `${styles.tab} ${isActive ? styles.tabActive : ''}`
            }
          >
            <span className={styles.tabIcon}>{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <div className={styles.body}>
        <Outlet />
      </div>
    </div>
  )
}
