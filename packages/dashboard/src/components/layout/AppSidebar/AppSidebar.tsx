import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useMatch } from 'react-router-dom'
import { Avatar } from '../../ui/Avatar'
import { useChatContext } from '../../../context/ChatContext'
import { useZenMode } from '../../../context/ZenModeContext'
import { getAvatarColor } from '../../../utils/avatar'
import { GroupSettingsModal } from '../../../features/groups/modals/GroupSettingsModal'
import styles from './AppSidebar.module.css'
const NAV_TABS = [
  { id: 'agents', label: '员工管理', icon: '👥', path: '/dashboard/agents' },
  { id: 'groups', label: '对话', icon: '💬', path: '/dashboard/groups' },
  { id: 'kanban', label: '看板', icon: '📋', path: '/dashboard/kanban' },
  { id: 'teams', label: '团队', icon: '🌐', path: '/dashboard/teams' },
  { id: 'toolbox', label: '工具箱', icon: '🧰', path: '/dashboard/toolbox' },
] as const
const ZEN_WIDTH = 56
const NORMAL_DEFAULT = 280
const NORMAL_MIN = 200
const MAX_WIDTH = 520

// 群类型 → 显示标签。null/空/"chat" 走默认(不显示 badge,避免视觉噪音)。
function getGroupTypeBadge(type?: string | null): { label: string; title: string; cls: string } | null {
  if (!type) return null
  if (type === 'patrol') return { label: '巡检', title: '巡检群:定时自动派单', cls: 'typePatrol' }
  if (type === 'patrol-link') return { label: '链接', title: '链接分类巡检群:定时自动归类采集到的链接', cls: 'typePatrol' }
  if (type === 'a2a_direct') return { label: '单播', title: '单播群(unicast):消息只入库不广播,需 --need-reply 点名', cls: 'typeUnicast' }
  if (type === 'direct') return { label: '单聊', title: '1 对 1 对话', cls: 'typeDirect' }
  return null
}

// "功能"分组:系统型群(patrol / patrol-link / a2a_direct)从主列表剥离,折叠到独立分组。
// 这些群不参与日常对话流,但偶尔需要查看 / 操作,折叠起来避免污染主列表。
function isFunctionalGroup(g: { type?: string | null }): boolean {
  return g.type === 'patrol' || g.type === 'patrol-link' || g.type === 'a2a_direct'
}
interface AppSidebarProps {
  width: number
  onWidthChange: (w: number) => void
}
// Tab 维度:4 个分类筛选,替代原"普通/功能/标记/已归档"4 段堆叠布局。
// - 普通:日常对话(排除 functional / starred / archived)
// - 功能:系统型群(patrol / patrol-link / a2a_direct,来自 isFunctionalGroup)
// - 标记:starred_at 非空
// - 已归档:archived_at 非空(只读)
type GroupTab = 'normal' | 'functional' | 'starred' | 'archived'

const TAB_LABEL: Record<GroupTab, string> = {
  normal: '普通',
  functional: '功能',
  starred: '标记',
  archived: '已归档',
}

const TAB_EMPTY_HINT: Record<GroupTab, string> = {
  normal: '暂无对话,点击「创建对话」开始',
  functional: '暂无功能型群',
  starred: '暂无标记群',
  archived: '暂无已归档对话',
}
export function AppSidebar({ width, onWidthChange }: AppSidebarProps) {
  const { zenMode, toggleZenMode } = useZenMode()
  // AppSidebar is rendered above <Routes>, so useParams() can't see the route
  // params. Match the URL directly to discover the active group id.
  const groupMatch = useMatch('/dashboard/groups/:groupId/*')
  const urlGroupId = groupMatch?.params.groupId
  const {
    agents,
    groups,
    myAgentName,
    selectGroup,
    openCreateGroupModal,
    openConfigModal,
    updateGroupName,
    updateGroupGuidancePrompt,
    updateGroupRepo,
    updateGroupWorkingDir,
    toggleGroupPinned,
    toggleGroupArchived,
    toggleGroupStarred,
    deleteGroup,
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
  const [moreMenuGroup, setMoreMenuGroup] = useState<string | null>(null)
  // Dropdown 通过 portal 渲染到 body 避开了 .groupList 的 overflow-y:auto,
  // 位置在点击瞬间从按钮的 getBoundingClientRect 算出来,所以滚动/resize 必须关闭。
  const moreBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const tabBarRef = useRef<HTMLDivElement | null>(null)
  const [tabBarHasMore, setTabBarHasMore] = useState(false)
  const [moreMenuPos, setMoreMenuPos] = useState<{ top: number; left: number } | null>(null)
  const moreBtnRectRef = useRef<{ top: number; bottom: number; right: number } | null>(null)
  const moreDropdownRef = useRef<HTMLDivElement | null>(null)
  const [settingsGroupId, setSettingsGroupId] = useState<string | null>(null)
  const startStateRef = useRef<{ x: number; w: number } | null>(null)
  const [activeTab, setActiveTab] = useState<GroupTab>('normal')
  // 跟踪 tabBar 横向滚动,当右侧还有内容没露出时给容器打 data 属性,CSS 渲染右边阴影。
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return
    const update = () => {
      setTabBarHasMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // 字体加载 / 群数变化导致 tab 内容宽度变化,延迟一帧再算一次。
    const id = window.setTimeout(update, 50)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      window.clearTimeout(id)
    }
  }, [activeTab, groups.length])
  // Close more-menu dropdown on outside click
  useEffect(() => {
    if (!moreMenuGroup) return
    const handleClick = () => {
      setMoreMenuGroup(null)
      setMoreMenuPos(null)
    }
    // Use setTimeout so the trigger button's onClick runs first
    const id = setTimeout(() => document.addEventListener('mousedown', handleClick), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [moreMenuGroup])

  // 位置在点击瞬间锁死,滚动/缩放后按钮位置会变,直接关掉避免错位。
  useEffect(() => {
    if (!moreMenuGroup) return
    const close = () => {
      setMoreMenuGroup(null)
      setMoreMenuPos(null)
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [moreMenuGroup])

  // 弹窗挂载后测量高度:下方空间不足时翻转为向上展开,避免末尾「删除」被视口下边裁掉。
  useLayoutEffect(() => {
    const el = moreDropdownRef.current
    const rect = moreBtnRectRef.current
    if (!el || !rect || !moreMenuGroup) return
    const height = el.offsetHeight
    const viewportH = window.innerHeight
    let top = rect.bottom + 4
    if (top + height > viewportH - 8) {
      top = rect.top - height - 4
    }
    if (top < 8) top = 8
    setMoreMenuPos((prev) => prev && Math.abs(prev.top - top) < 0.5 ? prev : { top, left: prev?.left ?? Math.max(8, rect.right - 140) })
  }, [moreMenuGroup])
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
  // 分层:置顶(在 active 内排首) → 普通活跃 → 🧰功能 → ⭐重要少用 → 🗄️已归档。
  // active = 既没归档也没标重要少用的所有群(包括还没发过消息的新建空群),且非功能型
  //   (patrol / patrol-link / a2a_direct 折到 FunctionalSection,不进主列表)。
  // starred = 标了 starred_at 但没归档(归档优先级高于 starred),也排除功能型(功能型固定走功能分组)。
  // archived = 已归档,只读。
  const activeGroups = groups
    .filter((g) => !g.name.startsWith('__dm__:') && !g.archived_at && !g.starred_at && !isFunctionalGroup(g))
    .slice()
    .sort((a, b) => {
      if (a.pinned_at && b.pinned_at) return b.pinned_at.localeCompare(a.pinned_at)
      if (a.pinned_at) return -1
      if (b.pinned_at) return 1
      // 有对话的群按最后消息时间倒序(最近的在前),无 last_message_at 的(如新建单聊)兜底用 created_at。
      return (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at)
    })
  const functionalGroups = groups
    .filter((g) => !g.name.startsWith('__dm__:') && !g.archived_at && isFunctionalGroup(g))
    .slice()
    .sort((a, b) => {
      // 功能分组内排序:patrol > patrol-link > a2a_direct,同类按 created_at 倒序
      const rank = (t?: string | null) => t === 'patrol' ? 0 : t === 'patrol-link' ? 1 : t === 'a2a_direct' ? 2 : 9
      const ra = rank(a.type), rb = rank(b.type)
      if (ra !== rb) return ra - rb
      return (b.created_at || '').localeCompare(a.created_at || '')
    })
  const starredGroups = groups
    .filter((g) => !g.name.startsWith('__dm__:') && g.starred_at && !g.archived_at && !isFunctionalGroup(g))
    .slice()
    .sort((a, b) => (b.starred_at || '').localeCompare(a.starred_at || ''))
  const archivedGroups = groups
    .filter((g) => g.archived_at)
    .slice()
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  const displayGroups = activeGroups
  // 顶部 tab 状态:默认「普通」。已归档不常用,放第 4 位避免视觉权重过高。
  const tabCounts: Record<GroupTab, number> = {
    normal: activeGroups.length,
    functional: functionalGroups.length,
    starred: starredGroups.length,
    archived: archivedGroups.length,
  }
  const currentGroups = (() => {
    switch (activeTab) {
      case 'normal': return activeGroups
      case 'functional': return functionalGroups
      case 'starred': return starredGroups
      case 'archived': return archivedGroups
    }
  })()
  const isAllEmpty = tabCounts.normal === 0 && tabCounts.functional === 0 && tabCounts.starred === 0 && tabCounts.archived === 0
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
    <div className={styles.sidebarWrap} style={{ width: `${width}px` }}>
      <aside
        className={`${styles.sidebar} ${isZen ? styles.sidebarZen : ''}`}
        style={{ width: `${width}px` }}
      >
        <div className={styles.topBar}>
          {!isZen && myAgentName ? (
            <button
              className={styles.userInfo}
              onClick={openConfigModal}
              title="切换身份"
            >
              <Avatar name={myAgentName} src={agents.find(a => a.name === myAgentName)?.avatar_url ?? undefined} size={28} />
              <span className={styles.userName}>{myAgentName}</span>
            </button>
          ) : (
            <div className={styles.brand}>
              <img src="/dashboard/rotom-avatar.png" alt="Rotom" className={styles.logoImg} />
              {!isZen && <span className={styles.logoText}>Rotom</span>}
            </div>
          )}
          <button
            className={styles.zenBtn}
            onClick={toggleZenMode}
            title={isZen ? '展开侧边栏' : '禅模式'}
          >
            {isZen ? '▶' : '◀'}
          </button>
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
              <button type="button"
              className={styles.navToggleBtn}
              onClick={toggleNavCompact}
              title={navCompact ? '展开导航' : '收起导航为一行'}
            >
              {navCompact ? '⇲' : '⇱'}
            </button>
          )}
        </nav>
        {!isZen && <hr className={styles.navDivider} />}
        {isZen ? (
          <div className={styles.zenBody}>
            {displayGroups.length > 0 && (
              <ul className={styles.zenList}>
                {displayGroups.map((group) => (
                  <li key={group.id}>
                      <button type="button"
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
            <div className={`${styles.section} ${styles.sectionGroup}`}>
              <div className={styles.sectionHeader}>
                <div ref={tabBarRef} className={styles.tabBar} data-has-more={tabBarHasMore || undefined}>
                  {(['normal', 'functional', 'starred', 'archived'] as GroupTab[]).map(tab => (
                    <button
                      key={tab}
                      type="button"
                      className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {TAB_LABEL[tab]}
                      <span className={styles.tabCount}>{tabCounts[tab]}</span>
                    </button>
                  ))}
                </div>
                <button onClick={openCreateGroupModal} className={styles.createBtn}>
                  + 创建
                </button>
              </div>
              {isAllEmpty ? (
                <div className={styles.hint}>暂无对话,点击「创建对话」开始</div>
              ) : currentGroups.length === 0 ? (
                <div className={styles.hint}>{TAB_EMPTY_HINT[activeTab]}</div>
              ) : (
                <ul className={styles.groupList}>
                  {currentGroups.map((group) => {
                    const isPinned = Boolean(group.pinned_at)
                    const isStarred = Boolean(group.starred_at)
                    const isArchived = Boolean(group.archived_at)
                    const typeBadge = getGroupTypeBadge(group.type)
                    // 行图标优先级:已归档 > 标记 > 置顶 > 功能型(走 typeBadge) > 无
                    const rowIcon = isArchived
                      ? { emoji: '🗄️', cls: 'archivedMark', title: '已归档' }
                      : isStarred
                        ? { emoji: '⭐', cls: 'starredMark', title: '标记' }
                        : isPinned
                          ? { emoji: '📌', cls: 'pinnedMark', title: '已置顶' }
                          : null
                    return (
                      <li
                        key={group.id}
                        className={`${styles.groupItem} ${
                          selectedGroupId === group.id ? styles.active : ''
                        } ${isPinned ? styles.pinned : ''} ${
                          isStarred ? styles.starred : ''
                        } ${isArchived ? styles.archived : ''}`}
                        onClick={() => selectGroup(group.id)}
                      >
                        <div className={styles.groupBody}>
                          <div className={styles.groupName}>
                            {rowIcon && (
                              <span className={styles[rowIcon.cls as keyof typeof styles] as string} title={rowIcon.title}>
                                {rowIcon.emoji}
                              </span>
                            )}
                            <span className={styles.groupNameText}>{group.name}</span>
                            {typeBadge && (
                              <span
                                className={`${styles.typeBadge} ${styles[typeBadge.cls]}`}
                                title={typeBadge.title}
                              >
                                {typeBadge.label}
                              </span>
                            )}
                            {group.type !== 'direct' && (
                              <span className={styles.memberCount}>
                                {`· ${group.member_count || 0} 位`}
                              </span>
                            )}
                          </div>
                        </div>
                        {/* 当前 tab 专属快捷按钮:hover 才显示 */}
                        {activeTab === 'starred' && (
                          <button
                            type="button"
                            className={styles.starBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleGroupStarred(group.id, false)
                            }}
                            title="取消标记"
                          >
                            取消标记
                          </button>
                        )}
                        {activeTab === 'archived' && (
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
                        )}
                        <div className={styles.moreWrap}>
                          <button
                            ref={(el) => { moreBtnRefs.current[group.id] = el }}
                            type="button"
                            className={styles.moreBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (moreMenuGroup === group.id) {
                                setMoreMenuGroup(null)
                                setMoreMenuPos(null)
                                return
                              }
                              const btn = moreBtnRefs.current[group.id]
                              if (btn) {
                                const rect = btn.getBoundingClientRect()
                                moreBtnRectRef.current = { top: rect.top, bottom: rect.bottom, right: rect.right }
                                setMoreMenuPos({
                                  top: rect.bottom + 4,
                                  left: Math.max(8, rect.right - 140),
                                })
                              }
                              setMoreMenuGroup(group.id)
                            }}
                            title="更多操作"
                          >
                            ···
                          </button>
                          {moreMenuGroup === group.id && moreMenuPos && createPortal(
                            <div
                              ref={moreDropdownRef}
                              className={styles.moreDropdown}
                              style={{
                                position: 'fixed',
                                top: moreMenuPos.top,
                                left: moreMenuPos.left,
                              }}
                              onMouseDown={e => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className={styles.moreItem}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setMoreMenuGroup(null)
                                  setMoreMenuPos(null)
                                  setSettingsGroupId(group.id)
                                }}
                              >
                                ⚙️ 设置
                              </button>
                              <button
                                type="button"
                                className={styles.moreItem}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleGroupPinned(group.id, !isPinned)
                                  setMoreMenuGroup(null)
                                  setMoreMenuPos(null)
                                }}
                              >
                                {isPinned ? '📌 取消置顶' : '📌 置顶'}
                              </button>
                              <button
                                type="button"
                                className={styles.moreItem}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleGroupStarred(group.id, !isStarred)
                                  setMoreMenuGroup(null)
                                  setMoreMenuPos(null)
                                }}
                              >
                                {isStarred ? '⭐ 取消标记' : '⭐ 标记'}
                              </button>
                              <button
                                type="button"
                                className={styles.moreItem}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleGroupArchived(group.id, !isArchived)
                                  setMoreMenuGroup(null)
                                  setMoreMenuPos(null)
                                }}
                              >
                                {isArchived ? '🗄️ 取消归档' : '🗄️ 归档'}
                              </button>
                              <div className={styles.moreDivider} />
                              <button
                                type="button"
                                className={`${styles.moreItem} ${styles.moreItemDanger}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setMoreMenuGroup(null)
                                  setMoreMenuPos(null)
                                  deleteGroup(group.id)
                                }}
                              >
                                🗑️ 删除对话
                              </button>
                            </div>,
                            document.body
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </aside>
      {settingsGroupId && (() => {
        const g = groups.find(grp => grp.id === settingsGroupId)
        if (!g) return null
        return (
          <GroupSettingsModal
            open={true}
            groupId={g.id}
            groupName={g.name}
            groupWorkingDir={g.working_dir}
            groupGuidancePrompt={g.guidance_prompt}
            groupRepoUrl={g.repo_url}
            groupRepoDefaultBranch={g.repo_default_branch}
            groupExtraRepos={g.extra_repos}
            groupWorktreeMode={g.worktree_mode}
            memberAgentNames={(g.members ?? []).map(m => m.agent_name)}
            onClose={() => setSettingsGroupId(null)}
            onSaveName={(name) => updateGroupName(g.id, name)}
            onSaveWorkingDir={(dir) => updateGroupWorkingDir(g.id, dir)}
            onSaveGuidancePrompt={(prompt) => updateGroupGuidancePrompt(g.id, prompt)}
            onSaveRepo={(data) => updateGroupRepo(g.id, data)}
          />
        )
      })()}
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
