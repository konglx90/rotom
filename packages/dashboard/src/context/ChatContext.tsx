import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { agentsApi } from '../api/agents'
import { groupsApi } from '../api/groups'
import { schedulesApi } from '../api/schedules'
import type { Agent, Group, GuidanceScheduleConfig } from '../api/types'
import {
  DM_GROUP_PREFIX,
  generateDmGroupName,
  getDmTargetFromGroupName,
} from '../features/groups/types'

export interface DmGroup extends Group {
  dmTarget: string
}

interface ChatContextValue {
  // Data
  agents: Agent[]
  agentsLoading: boolean
  agentsError: string | null
  groups: Group[]
  dmGroups: DmGroup[]
  onlineAgents: Agent[]

  // Identity
  myAgentName: string
  myAgentToken: string
  setMyAgentConfig: (name: string, token: string) => void

  // Config modal
  showConfigModal: boolean
  openConfigModal: () => void
  closeConfigModal: () => void

  // Create-group modal
  showCreateGroupModal: boolean
  openCreateGroupModal: () => void
  closeCreateGroupModal: () => void

  // Direct mode
  directTarget: string
  setDirectTarget: (name: string) => void

  // Data loading
  loadAgents: (silent?: boolean) => Promise<void>
  loadGroups: () => Promise<void>

  // Sidebar actions
  handleDirectChat: (targetName: string) => Promise<void>
  handleNewDmConversation: (targetName: string) => Promise<void>
  activateDmGroup: (groupId: string, targetName: string) => void
  selectGroup: (groupId: string) => void
  createGroup: (
    name: string,
    memberNames: string[],
    workingDir?: string,
    type?: string,
    guidancePrompt?: string,
    scheduleConfig?: GuidanceScheduleConfig,
    repoConfig?: { repoUrl: string | null; repoDefaultBranch: string | null; extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode: 'group' | 'issue' | null },
  ) => Promise<void>
  updateGroupWorkingDir: (groupId: string, workingDir: string | null) => Promise<void>
  setGroupMemberWorkingDir: (groupId: string, agentName: string, workingDir: string) => Promise<void>
  clearGroupMemberWorkingDir: (groupId: string, agentName: string) => Promise<void>
  updateGroupName: (groupId: string, name: string) => Promise<void>
  updateGroupGuidancePrompt: (groupId: string, prompt: string | null) => Promise<void>
  updateGroupRepo: (groupId: string, data: { repoUrl: string | null; repoDefaultBranch: string | null; extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode?: 'group' | 'issue' | null }) => Promise<void>
  toggleGroupPinned: (groupId: string, pinned: boolean) => Promise<void>
  deleteGroup: (groupId: string) => Promise<void>
  toggleGroupArchived: (groupId: string, archived: boolean) => Promise<void>
  toggleGroupStarred: (groupId: string, starred: boolean) => Promise<void>
}

const ChatContext = createContext<ChatContextValue | null>(null)

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()

  const [agents, setAgents] = useState<Agent[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  // Read saved identity synchronously so route guards don't see an empty
  // value on first render and bounce the user to /agents on every refresh.
  const [myAgentName, setMyAgentName] = useState<string>(
    () => localStorage.getItem('chat_agent_name') ?? '',
  )
  const [myAgentToken, setMyAgentToken] = useState<string>(
    () => localStorage.getItem('chat_agent_token') ?? '',
  )
  // Don't force the agent-config modal open on first load — the dashboard is
  // browseable without an identity. Users open it on demand from the sidebar
  // or when they try to send a DM.
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false)
  const [showCreateGroupModal, setShowCreateGroupModal] = useState<boolean>(false)
  const [directTarget, setDirectTargetState] = useState<string>('')

  const loadAgents = useCallback(async (silent = false) => {
    if (!silent) setAgentsLoading(true)
    setAgentsError(null)
    try {
      const data = await agentsApi.list()
      setAgents(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load agents'
      setAgentsError(message)
      console.error('Failed to load agents:', error)
    } finally {
      setAgentsLoading(false)
    }
  }, [])

  const loadGroups = useCallback(async () => {
    try {
      const data = await groupsApi.list()
      setGroups(data)
    } catch (error) {
      console.error('Failed to load groups:', error)
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadAgents()
    loadGroups()
  }, [loadAgents, loadGroups])

  // Refresh agent status when page returns to foreground
  const lastRefreshRef = useRef(0)
  useEffect(() => {
    const REFRESH_COOLDOWN = 30_000

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRefreshRef.current < REFRESH_COOLDOWN) return
      lastRefreshRef.current = now
      loadAgents(true)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [loadAgents])

  const setMyAgentConfig = useCallback((name: string, token: string) => {
    setMyAgentName(name)
    setMyAgentToken(token)
    setShowConfigModal(false)
  }, [])

  const openConfigModal = useCallback(() => {
    setShowConfigModal(true)
  }, [])
  const closeConfigModal = useCallback(() => setShowConfigModal(false), [])
  const openCreateGroupModal = useCallback(() => setShowCreateGroupModal(true), [])
  const closeCreateGroupModal = useCallback(() => setShowCreateGroupModal(false), [])

  const setDirectTarget = useCallback((name: string) => {
    setDirectTargetState(name)
    if (name) {
      localStorage.setItem('dm_active_target', name)
    }
  }, [])

  // Derived data
  const onlineAgents = useMemo(
    () => agents.filter((a) => a.status === 'online' && a.name !== myAgentName),
    [agents, myAgentName],
  )

  const dmGroups = useMemo<DmGroup[]>(
    () =>
      groups
        .filter(
          (g) =>
            g.name.startsWith(DM_GROUP_PREFIX) &&
            g.members?.some((m) => m.agent_name === myAgentName),
        )
        .map((g) => ({ ...g, dmTarget: getDmTargetFromGroupName(g.name) || '' }))
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [groups, myAgentName],
  )

  const selectGroup = useCallback(
    (groupId: string) => {
      setDirectTargetState('')
      localStorage.removeItem('dm_active_target')
      localStorage.removeItem('dm_active_group')
      if (groupId) {
        localStorage.setItem('group_selected_id', groupId)
        navigate(`/dashboard/groups/${groupId}`)
      } else {
        navigate('/dashboard/groups')
      }
    },
    [navigate],
  )

  const activateDmGroup = useCallback(
    (groupId: string, targetName: string) => {
      setDirectTargetState(targetName)
      localStorage.setItem('dm_active_target', targetName)
      localStorage.setItem('dm_active_group', groupId)
      localStorage.setItem('group_selected_id', groupId)
      navigate(`/dashboard/groups/${groupId}`)
    },
    [navigate],
  )

  const createGroup = useCallback(
    async (
      name: string,
      memberNames: string[],
      workingDir?: string,
      type?: string,
      guidancePrompt?: string,
      scheduleConfig?: GuidanceScheduleConfig,
      repoConfig?: { repoUrl: string | null; repoDefaultBranch: string | null; extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode: 'group' | 'issue' | null },
    ) => {
      if (!myAgentName) return
      try {
        const created = await groupsApi.create({
          name,
          memberNames: type === 'patrol' ? memberNames : [...memberNames, myAgentName],
          workingDir,
          type,
        })
        // 建群后落地模板:先写 guidance_prompt,再建定时任务(若模板带 schedule_config)
        const followups: Promise<unknown>[] = []
        if (guidancePrompt) {
          followups.push(groupsApi.updateGuidancePrompt(created.id, guidancePrompt))
        }
        if (repoConfig && (repoConfig.repoUrl || repoConfig.extraRepos?.length)) {
          followups.push(groupsApi.updateRepo(created.id, repoConfig))
        }
        if (scheduleConfig) {
          followups.push(schedulesApi.create({
            name: `${name}-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
            group_id: created.id,
            mode: scheduleConfig.mode,
            agent_name: scheduleConfig.agent_name,
            schedule_kind: scheduleConfig.schedule_kind,
            interval_sec: scheduleConfig.interval_sec,
            run_at: scheduleConfig.run_at,
            prompt: scheduleConfig.prompt,
            repeat_times: scheduleConfig.repeat_times ?? null,
            enabled: true,
          }))
        }
        if (followups.length > 0) {
          await Promise.all(followups).catch(err => {
            // 模板落地失败不阻塞建群,只提示
            console.error('Failed to apply guidance template after group creation:', err)
            window.alert(`群已创建,但模板落地失败: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
        setShowCreateGroupModal(false)
        await loadGroups()
      } catch (error) {
        console.error('Failed to create group:', error)
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`创建群失败：${msg}`)
        throw error
      }
    },
    [myAgentName, loadGroups],
  )

  const updateGroupWorkingDir = useCallback(
    async (groupId: string, workingDir: string | null) => {
      try {
        await groupsApi.updateWorkingDir(groupId, workingDir)
        await loadGroups()
      } catch (error) {
        console.error('Failed to update group workingDir:', error)
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`修改工作目录失败：${msg}`)
        throw error
      }
    },
    [loadGroups],
  )

  // Optimistic local update of one member's per-(group, agent) working_dir
  // override. Rolls back to the server truth on failure.
  const setGroupMemberWorkingDir = useCallback(
    async (groupId: string, agentName: string, workingDir: string) => {
      const snapshot = groups
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g
          const members = (g.members || []).map((m) =>
            m.agent_name === agentName ? { ...m, working_dir: workingDir } : m,
          )
          return { ...g, members }
        }),
      )
      try {
        await groupsApi.setMemberWorkingDir(groupId, agentName, workingDir)
      } catch (error) {
        console.error('Failed to set member workingDir:', error)
        setGroups(snapshot)
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`设置成员工作目录失败：${msg}`)
        throw error
      }
    },
    [groups],
  )

  const clearGroupMemberWorkingDir = useCallback(
    async (groupId: string, agentName: string) => {
      const snapshot = groups
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id !== groupId) return g
          const members = (g.members || []).map((m) =>
            m.agent_name === agentName ? { ...m, working_dir: null } : m,
          )
          return { ...g, members }
        }),
      )
      try {
        await groupsApi.clearMemberWorkingDir(groupId, agentName)
      } catch (error) {
        console.error('Failed to clear member workingDir:', error)
        setGroups(snapshot)
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`清除成员工作目录失败：${msg}`)
        throw error
      }
    },
    [groups],
  )

  // Optimistic toggle: patch local state first so the pin reordering is
  // instant; reconcile with the server response so the canonical pinned_at
  // timestamp ends up matching what the next /groups fetch returns.
  const updateGroupName = useCallback(
    async (groupId: string, name: string) => {
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, name } : g)),
      )
      try {
        await groupsApi.updateName(groupId, name)
        await loadGroups()
      } catch (error) {
        console.error('Failed to update group name:', error)
        await loadGroups()
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`更新群名称失败：${msg}`)
      }
    },
    [loadGroups],
  )

  const toggleGroupPinned = useCallback(
    async (groupId: string, pinned: boolean) => {
      const optimisticPinnedAt = pinned ? new Date().toISOString() : null
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, pinned_at: optimisticPinnedAt } : g)),
      )
      try {
        await groupsApi.setPinned(groupId, pinned)
        await loadGroups()
      } catch (error) {
        console.error('Failed to toggle group pin:', error)
        await loadGroups()
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`置顶操作失败：${msg}`)
      }
    },
    [loadGroups],
  )

  const updateGroupGuidancePrompt = useCallback(
    async (groupId: string, prompt: string | null) => {
      try {
        await groupsApi.updateGuidancePrompt(groupId, prompt)
        await loadGroups()
      } catch (error) {
        console.error('Failed to update group guidance prompt:', error)
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`更新群指导 prompt 失败：${msg}`)
        throw error
      }
    },
    [loadGroups],
  )
  const updateGroupRepo = useCallback(
    async (groupId: string, data: { repoUrl: string | null; repoDefaultBranch: string | null; extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null; worktreeMode?: 'group' | 'issue' | null }) => {
      try {
        await groupsApi.updateRepo(groupId, data)
        await loadGroups()
      } catch (error) {
        console.error('Failed to update group repo:', error)
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`更新群 repo 配置失败：${msg}`)
        throw error
      }
    },
    [loadGroups],
  )
  const toggleGroupArchived = useCallback(
    async (groupId: string, archived: boolean) => {
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, archived } : g)),
      )
      try {
        await groupsApi.setArchived(groupId, archived)
        await loadGroups()
      } catch (error) {
        console.error("Failed to toggle group archive:", error)
        await loadGroups()
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`归档操作失败：${msg}`)
      }
    },
    [loadGroups],
  )

  const toggleGroupStarred = useCallback(
    async (groupId: string, starred: boolean) => {
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, starred_at: starred ? new Date().toISOString() : null } : g)),
      )
      try {
        await groupsApi.setStarred(groupId, starred)
        await loadGroups()
      } catch (error) {
        console.error("Failed to toggle group star:", error)
        await loadGroups()
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`标记重要少用失败：${msg}`)
      }
    },
    [loadGroups],
  )



  const deleteGroup = useCallback(
    async (groupId: string) => {
      if (!window.confirm('确定要删除这个群吗？所有消息将被清除。')) return
      setGroups((prev) => prev.filter((g) => g.id !== groupId))
      try {
        await groupsApi.delete(groupId)
        await loadGroups()
      } catch (error) {
        console.error('Failed to delete group:', error)
        await loadGroups()
        const msg = error instanceof Error ? error.message : String(error)
        window.alert(`删除群失败：${msg}`)
      }
    },
    [loadGroups],
  )

  const handleNewDmConversation = useCallback(
    async (targetName: string) => {
      if (!myAgentName) return
      const existing = dmGroups.filter((g) => g.dmTarget === targetName)
      const newName = generateDmGroupName(targetName, existing.length)
      try {
        const newGroup = await groupsApi.create({
          name: newName,
          memberNames: [myAgentName, targetName],
        })
        await loadGroups()
        activateDmGroup(newGroup.id, targetName)
      } catch (error) {
        console.error('Failed to create DM group:', error)
      }
    },
    [myAgentName, dmGroups, loadGroups, activateDmGroup],
  )

  const handleDirectChat = useCallback(
    async (targetName: string) => {
      if (!myAgentName) {
        setShowConfigModal(true)
        return
      }
      const dmGroupsForTarget = dmGroups.filter((g) => g.dmTarget === targetName)
      if (dmGroupsForTarget.length > 0) {
        const latest = dmGroupsForTarget[dmGroupsForTarget.length - 1]
        activateDmGroup(latest.id, targetName)
        return
      }
      await handleNewDmConversation(targetName)
    },
    [myAgentName, dmGroups, activateDmGroup, handleNewDmConversation],
  )

  // Restore DM state once after groups/myAgentName become available
  const initialRestoreRef = useRef(false)
  useEffect(() => {
    if (initialRestoreRef.current) return
    if (groups.length === 0 || !myAgentName) return
    initialRestoreRef.current = true
    const savedTarget = localStorage.getItem('dm_active_target')
    const savedGroup = localStorage.getItem('dm_active_group')
    if (!savedTarget) return
    if (savedGroup) {
      const group = groups.find((g) => g.id === savedGroup)
      if (group) {
        setDirectTargetState(savedTarget)
        return
      }
    }
    const dmGroup = groups.find(
      (g) =>
        g.name.startsWith(DM_GROUP_PREFIX) &&
        getDmTargetFromGroupName(g.name) === savedTarget &&
        g.members?.some((m) => m.agent_name === myAgentName),
    )
    if (dmGroup) {
      setDirectTargetState(savedTarget)
    }
  }, [groups, myAgentName])

  const value: ChatContextValue = {
    agents,
    agentsLoading,
    agentsError,
    groups,
    dmGroups,
    onlineAgents,
    myAgentName,
    myAgentToken,
    setMyAgentConfig,
    showConfigModal,
    openConfigModal,
    closeConfigModal,
    showCreateGroupModal,
    openCreateGroupModal,
    closeCreateGroupModal,
    directTarget,
    setDirectTarget,
    loadAgents,
    loadGroups,
    handleDirectChat,
    handleNewDmConversation,
    activateDmGroup,
    selectGroup,
    createGroup,
    updateGroupName,
    updateGroupGuidancePrompt,
    updateGroupRepo,
    updateGroupWorkingDir,
    setGroupMemberWorkingDir,
    clearGroupMemberWorkingDir,
    toggleGroupPinned,
    toggleGroupArchived,
    toggleGroupStarred,
    deleteGroup,
  }

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatContext must be used inside <ChatProvider>')
  return ctx
}
