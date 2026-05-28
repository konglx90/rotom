import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useZenMode } from '../../../context/ZenModeContext'
import { useAuth } from '../../../context/AuthContext'
import { AppSidebar } from '../AppSidebar/AppSidebar'
import styles from './AppShell.module.css'

const ZEN_DEFAULT = 56
const NORMAL_DEFAULT = 280

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { zenMode } = useZenMode()
  const { isPreview, logout } = useAuth()
  const location = useLocation()
  const isFullBleed = location.pathname.startsWith('/dashboard/groups')
  const hideSidebar = /^\/dashboard\/groups\/[^/]+\/issues-single(\/|$)/.test(
    location.pathname,
  )
  const widthStorageKey = zenMode ? 'sidebar_width_zen' : 'sidebar_width_normal'

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem(widthStorageKey)
    if (saved !== null) {
      const n = Number(saved)
      if (Number.isFinite(n)) return Math.max(zenMode ? ZEN_DEFAULT : 0, n)
    }
    return zenMode ? ZEN_DEFAULT : NORMAL_DEFAULT
  })

  useEffect(() => {
    const saved = localStorage.getItem(widthStorageKey)
    if (saved !== null) {
      const n = Number(saved)
      if (Number.isFinite(n)) {
        setSidebarWidth(Math.max(zenMode ? ZEN_DEFAULT : 0, n))
        return
      }
    }
    setSidebarWidth(zenMode ? ZEN_DEFAULT : NORMAL_DEFAULT)
  }, [zenMode, widthStorageKey])

  const handleWidthChange = useCallback(
    (w: number) => {
      setSidebarWidth(w)
      localStorage.setItem(widthStorageKey, String(w))
    },
    [widthStorageKey],
  )

  // 预览横条默认收起;用户展开后状态持久化到 localStorage,刷新仍生效。
  // 选择默认收起是因为横条会挤压主区高度,大多数时候只需小药丸作提醒就够。
  const [previewCollapsed, setPreviewCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem('preview_banner_collapsed')
    return saved === null ? true : saved === '1'
  })
  const togglePreview = useCallback(() => {
    setPreviewCollapsed(prev => {
      const next = !prev
      localStorage.setItem('preview_banner_collapsed', next ? '1' : '0')
      return next
    })
  }, [])

  return (
    <div className={styles.shell}>
      {isPreview && !previewCollapsed && (
        <div className={styles.previewBanner} role="status">
          <span className={styles.previewBadge}>预览模式</span>
          <span className={styles.previewText}>只读会话:可浏览所有数据,但写操作已禁用。</span>
          <button type="button" className={styles.previewExit} onClick={logout}>
            退出预览
          </button>
          <button
            type="button"
            className={styles.previewCollapseBtn}
            onClick={togglePreview}
            title="收起提示"
            aria-label="收起预览提示"
          >
            ×
          </button>
        </div>
      )}
      {isPreview && previewCollapsed && (
        <button
          type="button"
          className={styles.previewPill}
          onClick={togglePreview}
          title="展开预览提示"
          aria-label="展开预览提示"
        >
          🔒 预览
        </button>
      )}
      <div className={styles.shellInner}>
        {!hideSidebar && <AppSidebar width={sidebarWidth} onWidthChange={handleWidthChange} />}
        <main
          className={`${styles.main} ${zenMode ? styles.mainZen : ''} ${
            isFullBleed ? styles.mainFullBleed : ''
          }`}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
