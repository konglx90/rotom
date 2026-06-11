import { useEffect, useRef, useState } from 'react'
import { NavLink, useMatch } from 'react-router-dom'
import { Avatar } from '../../ui/Avatar'
import { useChatContext } from '../../../context/ChatContext'
import { useZenMode } from '../../../context/ZenModeContext'
import { getAvatarColor } from '../../../utils/avatar'
import styles from './AppSidebar.module.css'

const NAV_TABS = [
  { id: 'agents', label: '员工管理', icon: '👥', path: '/dashboard/agents' },
  { id: 'groups', label: '对话', icon: '💬', path: '/dashboard/groups' },
  { id: 'kanban', label: '看板', icon: '📋', path: '/dashboard/kanban' },
  { id: 'messages', label: '消息流', icon: '📜', path: '/dashboard/messages' },
  { id: 'terminal', label: '终端', icon: '⌨️', path: '/dashboard/terminal' },
] as const

const ZEN_WIDTH = 56
const NORMAL_DEFAULT = 280
const NORMAL_MIN = 200
const MAX_WIDTH = 520

interface AppSidebarProps {
  width: number
  onWidthChange: (w: number) => void
}

function ArchivedSection({ archivedGroups, selectedGroupId, selectGroup, toggleGroupArchived }: {
  archivedGroups: { id: string; name: string; pinned_at?: string | null; member_count?: number; created_at: string }[]
  selectedGroupId: string
  selectGroup: (id: string) => void
  toggleGroupArchived: (id: string, archived: boolean) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={styles.archivedSection}>
      <div
        className={styles.archivedSectionHeader}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={styles.archivedSectionArrow}>
          {expanded ? '▼' : '▶'}
        </span>
        <span className={styles.archivedSectionTitle}>已归档</span>
        <span className={styles.archivedSectionCount}>{archivedGroups.length}</span>
      </div>
      {expanded && (
        <ul className={styles.groupList}>
          {archivedGroups.map((group) => {
            const isActive = selectedGroupId === group.id
            return (
              <li
                key={group.id}
                className={`${styles.groupItem} ${styles.archived} ${isActive ? styles.active : ''}`}
                onClick={() => selectGroup(group.id)}
              >
                <div className={styles.groupBody}>
                  <div className={styles.groupName}>
                    <span className={styles.archivedMark} title="已归档">🗄️</span>
                    {group.name}
                  </div>
                  <div className={styles.groupMeta}>已归档</div>
                </div>
                <button
                  type="button"
                  className={`${styles.archiveBtn} ${styles.archiveBtnActive}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleGroupArchived(group.id, false)
                  }}
                  title="取消归档"
                >
                  取消归档
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function AppSidebar({ width, onWidthChange }: AppSidebarProps) {
  const { zenMode, toggleZenMode } = useZenMode()
  // AppSidebar is rendered above <Routes>, so useParams() can't see the route
  // params. Match the URL directly to discover the active group id.
  const groupMatch = useMatch('/dashboard/groups/:groupId/*')
  const urlGroupId = groupMatch?.params.groupId
  const {
    onlineAgents,
    dmGroups,
    groups,
    directTarget,
    myAgentName,
    handleDirectChat,
    activateDmGroup,
    handleNewDmConversation,
    selectGroup,
    openCreateGroupModal,
    openConfigModal,
    toggleGroupPinned,
    toggleGroupArchived,
  } = useChatContext()

  const [dragging, setDragging] = useState(false)
  const [navCompact, setNavCompact] = useState(() => {
    try {
      const _stored = localStorage.getItem('rotom-nav-compact');
      if (_stored === null) {
        localStorage.setItem('rotom-nav-compact', '1');
        return true;
      }
      return _stored === '1'
    } catch {
      return false
    }
  })
  const [dmExpanded, setDmExpanded] = useState(false)
  const startStateRef = useRef<{ x: number; w: number } | null>(null)

  const toggleNavCompact = () => {
    setNavCompact((v) => {
      const next = !v
      try {
        localStorage.setItem('rotom-nav-compact', next ? '1' : '0')
      } catch {}
      return next
    })
  }

  const selectedGroupId = urlGroupId || ''
  const isZen = zenMode
  // Pinned groups first (sorted by most recently pinned), then active groups
  // by created_at DESC, then archived groups at the bottom.
  const activeGroups = groups
    .filter((g) => !g.name.startsWith('__dm__:') && !g.archived_at)
    .slice()
    .sort((a, b) => {
      if (a.pinned_at && b.pinned_at) return b.pinned_at.localeCompare(a.pinned_at)
      if (a.pinned_at) return -1
      if (b.pinned_at) return 1
      return 0
    })
  const archivedGroups = groups
    .filter((g) => g.archived_at)
    .slice()
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  const displayGroups = activeGroups

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

        <nav
          className={`${styles.nav} ${!isZen && navCompact ? styles.navCompact : ''}`}
        >
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
              {!isZen && !navCompact && <span className={styles.navLabel}>{tab.label}</span>}
            </NavLink>
          ))}
          {!isZen && (
            <button
              type="button"
              className={styles.navToggleBtn}
              onClick={toggleNavCompact}
              title={navCompact ? '展开导航' : '收起导航为一行'}
            >
              {navCompact ? '⇲' : '⇱'}
            </button>
          )}
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
            {(onlineAgents.length > 0 || archivedGroups.length > 0) && displayGroups.length > 0 && (
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
            {archivedGroups.length > 0 && displayGroups.length > 0 && onlineAgents.length === 0 && (
              <div className={styles.zenDivider} />
            )}
            {archivedGroups.length > 0 && (
              <>
                {displayGroups.length > 0 && onlineAgents.length > 0 && (
                  <div className={styles.zenDivider} />
                )}
                <ul className={styles.zenList}>
                  {archivedGroups.map((group) => (
                    <li key={group.id}>
                      <button
                        type="button"
                        className={`${styles.zenItem} ${styles.zenItemArchived} ${
                          selectedGroupId === group.id ? styles.zenItemActive : ''
                        }`}
                        onClick={() => selectGroup(group.id)}
                        title={`${group.name} (已归档)`}
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
              </>
            )}
          </div>
        ) : (
          <>
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>一对一</h3>
                {dmExpanded && (
                  <button
                    type="button"
                    className={styles.navToggleBtn}
                    onClick={() => setDmExpanded((v) => !v)}
                    title="收起一对一"
                  >
                    ⇱
                  </button>
                )}
              </div>
              {onlineAgents.length === 0 ? (
                <div className={styles.hint}>暂无在线 Agent</div>
              ) : dmExpanded ? (
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
                          <Avatar name={agent.name} size={28} />
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
              ) : (
                <div className={styles.dmAvatarRow}>
                  <div className={styles.dmAvatars}>
                    {onlineAgents.map((agent) => {
                      const conversations = getDmGroupsForTarget(agent.name)
                      return (
                        <div
                          key={agent.id}
                          className={`${styles.dmAvatarItem} ${
                            directTarget === agent.name ? styles.dmAvatarActive : ''
                          }`}
                          onClick={() => handleDirectChat(agent.name)}
                          title={agent.name + (conversations.length > 1 ? ` (${conversations.length} 对话)` : '')}
                        >
                          <Avatar name={agent.name} size={32} />
                          <div className={styles.dmAvatarDot} />
                          {conversations.length > 1 && (
                            <span className={styles.dmAvatarBadge}>{conversations.length}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    className={styles.navToggleBtn}
                    onClick={() => setDmExpanded((v) => !v)}
                    title={dmExpanded ? '收起一对一' : '展开一对一'}
                  >
                    {dmExpanded ? '⇱' : '⇲'}
                  </button>
                </div>
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
              {displayGroups.length === 0 && archivedGroups.length === 0 ? (
                <div className={styles.hint}>暂无群组</div>
              ) : (
                <>
                  {displayGroups.length > 0 && (
                    <ul className={styles.groupList}>
                      {displayGroups.map((group) => {
                        const isPinned = Boolean(group.pinned_at)
                        return (
                          <li
                            key={group.id}
                            className={`${styles.groupItem} ${
                              selectedGroupId === group.id ? styles.active : ''
                            } ${isPinned ? styles.pinned : ''}`}
                            onClick={() => selectGroup(group.id)}
                          >
                            <div className={styles.groupBody}>
                              <div className={styles.groupName}>
                                {isPinned && (
                                  <span className={styles.pinnedMark} title="已置顶">📌</span>
                                )}
                                {group.name}
                              </div>
                              <div className={styles.groupMeta}>
                                {`${group.member_count || 0} 位成员`}
                              </div>
                            </div>
                            <button
                              type="button"
                              className={`${styles.pinBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleGroupPinned(group.id, !isPinned)
                              }}
                              title={isPinned ? '取消置顶' : '置顶'}
                            >
                              {isPinned ? '取消置顶' : '置顶'}
                            </button>
                            <button
                              type="button"
                              className={styles.archiveBtn}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleGroupArchived(group.id, true)
                              }}
                              title="归档"
                            >
                              归档
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {archivedGroups.length > 0 && (
                    <ArchivedSection
                      archivedGroups={archivedGroups}
                      selectedGroupId={selectedGroupId}
                      selectGroup={selectGroup}
                      toggleGroupArchived={toggleGroupArchived}
                    />
                  )}
                </>
              )}
            </div>
          </>
        )}

        <div className={styles.footer}>
          {!isZen && myAgentName && (
            <button
              className={styles.userInfo}
              onClick={openConfigModal}
              title="切换身份"
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
