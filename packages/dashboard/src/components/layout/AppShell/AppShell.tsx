import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useZenMode } from '../../../context/ZenModeContext'
import { useChatContext } from '../../../context/ChatContext'
import { AppSidebar } from '../AppSidebar/AppSidebar'
import styles from './AppShell.module.css'

const ZEN_DEFAULT = 56
const NORMAL_DEFAULT = 280

interface AppShellProps {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { zenMode } = useZenMode()
  const { myAgentName, openConfigModal } = useChatContext()
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

  // 未绑定身份时全局横条提醒。消息/群聊页此时其实会被 RequireAgent 路由守卫
  // 弹回 /agents，所以横条主要落在 agents 页面，告诉用户「先挑一个身份」。
  const showIdentityBanner = !myAgentName

  return (
    <div className={styles.shell}>
      {showIdentityBanner && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px',
            background: '#fef3c7',
            color: '#78350f',
            borderBottom: '1px solid #fcd34d',
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600 }}>⚠️ 还没绑定身份</span>
          <span style={{ flex: 1 }}>
            你现在是匿名访问，需要先挑一个员工身份才能用。
          </span>
          <button
            type="button"
            onClick={openConfigModal}
            style={{
              background: '#f59e0b',
              color: '#fff',
              border: 'none',
              padding: '4px 12px',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            选择身份
          </button>
        </div>
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
