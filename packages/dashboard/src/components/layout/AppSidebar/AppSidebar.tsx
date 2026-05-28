import { useEffect, useRef, useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { Avatar } from '../../ui/Avatar'
import { useChatContext } from '../../../context/ChatContext'
import { useZenMode } from '../../../context/ZenModeContext'
import { getAvatarColor } from '../../../utils/avatar'
import styles from './AppSidebar.module.css'

const NAV_TABS = [
  { id: 'agents', label: '员工管理', icon: '👥', path: '/dashboard/agents' },
  { id: 'groups', label: '消息', icon: '💬', path: '/dashboard/groups' },
  { id: 'messages', label: '消息流', icon: '📜', path: '/dashboard/messages' },
] as const

const ZEN_WIDTH = 56
const NORMAL_DEFAULT = 280
const NORMAL_MIN = 200
const MAX_WIDTH = 520

interface AppSidebarProps {
  width: number
  onWidthChange: (w: number) => void
}

export function AppSidebar({ width, onWidthChange }: AppSidebarProps) {
  const { zenMode, toggleZenMode } = useZenMode()
  const { groupId: urlGroupId } = useParams<{ groupId?: string }>()
  const {
    onlineAgents,
    dmGroups,
    groups,
    directTarget,
    myAgentName,
    handleDirectChat,
    handleNewDmConversation,
    activateDmGroup,
    selectGroup,
    openCreateGroupModal,
    openConfigModal,
  } = useChatContext()

  const [dragging, setDragging] = useState(false)
  const startStateRef = useRef<{ x: number; w: number } | null>(null)

  const selectedGroupId = urlGroupId || ''
  const isZen = zenMode
  const displayGroups = groups.filter((g) => !g.name.startsWith('__dm__:'))

  const getDmGroupsForTarget = (targetName: string) =>
    dmGroups.filter((g) => g.dmTarget === targetName)

  useEffect(() => {
    if (!dragging) return
    const min = isZen ? ZEN_WIDTH : NORMAL_MIN
    const onMove = (e: MouseEvent) => {
      const start = startStateRef.current
      if (!start) return
      const next = Math.min(MAX_WIDTH, Math.max(min, start.w + (e.clientX - start.x)))
      onWidthChange(next)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, isZen, onWidthChange])

  const defaultWidth = isZen ? ZEN_WIDTH : NORMAL_DEFAULT

  return (
    <div className={styles.sidebarWrap} style={{ width: `${width + 6}px` }}>
      <aside
        className={`${styles.sidebar} ${isZen ? styles.sidebarZen : ''}`}
        style={{ width: `${width}px` }}
      >
        <div className={styles.logo}>
          <img src="/dashboard/rotom-avatar.png" alt="Rotom" className={styles.logoImg} />
          {!isZen && <span className={styles.logoText}>Rotom</span>}
        </div>

        <nav className={styles.nav}>
          {NAV_TABS.map((tab) => (
            <NavLink
              key={tab.id}
              to={tab.path}
              title={tab.label}
              className={({ isActive }) =>
                `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
              }
            >
              <span className={styles.navIcon}>{tab.icon}</span>
              {!isZen && <span className={styles.navLabel}>{tab.label}</span>}
            </NavLink>
          ))}
        </nav>

        {isZen ? (
          <div className={styles.zenBody}>
            {onlineAgents.length > 0 && (
              <ul className={styles.zenList}>
                {onlineAgents.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className={`${styles.zenItem} ${
                        directTarget === agent.name ? styles.zenItemActive : ''
                      }`}
                      onClick={() => handleDirectChat(agent.name)}
                      title={agent.name}
                    >
                      <Avatar name={agent.name} size={32} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {onlineAgents.length > 0 && displayGroups.length > 0 && (
              <div className={styles.zenDivider} />
            )}
            {displayGroups.length > 0 && (
              <ul className={styles.zenList}>
                {displayGroups.map((group) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      className={`${styles.zenItem} ${
                        selectedGroupId === group.id ? styles.zenItemActive : ''
                      }`}
                      onClick={() => selectGroup(group.id)}
                      title={group.name}
                    >
                      <span
                        className={styles.zenLetterAvatar}
                        style={{ background: getAvatarColor(group.name) }}
                      >
                        {(group.name.charAt(0) || '#').toUpperCase()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>一对一</h3>
              </div>
              {onlineAgents.length === 0 ? (
                <div className={styles.hint}>暂无在线 Agent</div>
              ) : (
                <ul className={styles.directList}>
                  {onlineAgents.map((agent) => {
                    const conversations = getDmGroupsForTarget(agent.name)
                    const isExpanded = directTarget === agent.name
                    return (
                      <li key={agent.id}>
                        <div
                          className={`${styles.directItem} ${
                            directTarget === agent.name ? styles.active : ''
                          }`}
                          onClick={() => handleDirectChat(agent.name)}
                        >
                          <Avatar name={agent.name} size={32} />
                          <div className={styles.directInfo}>
                            <div className={styles.directName}>{agent.name}</div>
                            {conversations.length > 1 && (
                              <div className={styles.directSubtext}>
                                {conversations.length} 个对话
                              </div>
                            )}
                          </div>
                          <button
                            className={styles.newConvBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleNewDmConversation(agent.name)
                            }}
                            title="新对话"
                          >
                            +
                          </button>
                          <div className={styles.directStatusDot} />
                        </div>
                        {isExpanded && conversations.length > 1 && (
                          <ul className={styles.convThreadList}>
                            {conversations.map((conv, idx) => (
                              <li
                                key={conv.id}
                                className={`${styles.convThreadItem} ${
                                  selectedGroupId === conv.id ? styles.active : ''
                                }`}
                                onClick={() => activateDmGroup(conv.id, agent.name)}
                              >
                                <span className={styles.convThreadLabel}>对话 {idx + 1}</span>
                                <span className={styles.convThreadTime}>
                                  {new Date(
                                    conv.created_at +
                                      (conv.created_at.includes('Z') || conv.created_at.includes('+')
                                        ? ''
                                        : 'Z'),
                                  ).toLocaleDateString('zh-CN', {
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    timeZone: 'Asia/Shanghai',
                                  })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className={styles.divider} />

            <div className={`${styles.section} ${styles.sectionGroup}`}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>群聊</h3>
                <button onClick={openCreateGroupModal} className={styles.createBtn}>
                  + 新建群
                </button>
              </div>
              {displayGroups.length === 0 ? (
                <div className={styles.hint}>暂无群组</div>
              ) : (
                <ul className={styles.groupList}>
                  {displayGroups.map((group) => (
                    <li
                      key={group.id}
                      className={`${styles.groupItem} ${
                        selectedGroupId === group.id ? styles.active : ''
                      }`}
                      onClick={() => selectGroup(group.id)}
                    >
                      <div className={styles.groupName}>{group.name}</div>
                      <div className={styles.groupMeta}>{group.member_count || 0} 位成员</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        <div className={styles.footer}>
          {!isZen && myAgentName && (
            <button
              className={styles.userInfo}
              onClick={openConfigModal}
              title="切换 Agent"
            >
              <Avatar name={myAgentName} size={24} />
              <span className={styles.userName}>{myAgentName}</span>
            </button>
          )}
          <button
            className={styles.zenBtn}
            onClick={toggleZenMode}
            title={isZen ? '展开侧边栏' : '禅模式'}
          >
            {isZen ? '▶' : '◀'}
          </button>
        </div>
      </aside>
      <div
        className={`${styles.resizer} ${dragging ? styles.resizerActive : ''}`}
        onMouseDown={(e) => {
          startStateRef.current = { x: e.clientX, w: width }
          setDragging(true)
        }}
        onDoubleClick={() => onWidthChange(defaultWidth)}
        title="拖拽调整宽度,双击恢复默认"
      />
    </div>
  )
}
