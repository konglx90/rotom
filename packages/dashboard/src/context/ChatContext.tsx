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
import type { Agent, Group } from '../api/types'
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
  createGroup: (name: string, memberNames: string[], workingDir?: string) => Promise<void>
  updateGroupWorkingDir: (groupId: string, workingDir: string | null) => Promise<void>
  toggleGroupPinned: (groupId: string, pinned: boolean) => Promise<void>
  toggleGroupArchived: (groupId: string, archived: boolean) => Promise<void>
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
    async (name: string, memberNames: string[], workingDir?: string) => {
      if (!myAgentName) return
      try {
        await groupsApi.create({
          name,
          memberNames: [...memberNames, myAgentName],
          workingDir,
        })
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

  // Optimistic toggle: patch local state first so the pin reordering is
  // instant; reconcile with the server response so the canonical pinned_at
  // timestamp ends up matching what the next /groups fetch returns.
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
    updateGroupWorkingDir,
    toggleGroupPinned,
    toggleGroupArchived,
  }

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatContext must be used inside <ChatProvider>')
  return ctx
}
