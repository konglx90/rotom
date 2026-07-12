// GroupChatView 的群动作 handlers:loadIssues / handleAddMembers / retrySelfJoin /
// handleDeleteDm / handleCreateIssue / handleArtifactClick,以及两个用到 loadIssues
// 的 effect(切群加载 issues、lastIssueChange 推送刷新)。从 GroupChatView.tsx 抽出。
// 纯逻辑 hook,行为与原内联版本逐字一致。
import { useCallback, useEffect } from 'react'
import { groupsApi } from '../../api/groups'
import { issuesApi } from '../../api/issues'
import type { Issue } from '../../api/types'
import type { PanelMode } from './panelMode'

interface UseGroupActionsArgs {
  selectedGroupId: string
  myAgentName: string
  directTargetResolved: string
  selfJoinError: { groupId: string; message: string } | null
  setSelfJoinError: (e: { groupId: string; message: string } | null) => void
  setDirectTarget: (v: string) => void
  setArtifactSelectedPath: (v: string | null) => void
  setMode: React.Dispatch<React.SetStateAction<PanelMode>>
  setShowAddMemberModal: (v: boolean) => void
  setIssues: React.Dispatch<React.SetStateAction<Issue[]>>
  setSelectedIssueId: (id: string) => void
  setSelectedIssueVersion: React.Dispatch<React.SetStateAction<number>>
  loadGroups: () => Promise<void> | void
  navigate: (path: string, opts?: { replace?: boolean }) => void
  lastIssueChange: { groupId: string; issueId: string } | null
  selectedIssueId: string
}

export function useGroupActions({
  selectedGroupId,
  myAgentName,
  directTargetResolved,
  selfJoinError,
  setSelfJoinError,
  setDirectTarget,
  setArtifactSelectedPath,
  setMode,
  setShowAddMemberModal,
  setIssues,
  setSelectedIssueId,
  setSelectedIssueVersion,
  loadGroups,
  navigate,
  lastIssueChange,
  selectedIssueId,
}: UseGroupActionsArgs) {
  const loadIssues = useCallback(async () => {
    if (!selectedGroupId) return
    try {
      const data = await issuesApi.listByGroup(selectedGroupId)
      setIssues(data)
    } catch (error) {
      console.error('Failed to load issues:', error)
    }
  }, [selectedGroupId])

  // 切群时加载 issues(或清空)。
  useEffect(() => {
    if (!selectedGroupId) {
      setIssues([])
      setSelectedIssueId('')
      return
    }
    loadIssues()
  }, [selectedGroupId, loadIssues])

  // React to global socket pushes.
  useEffect(() => {
    if (!lastIssueChange) return
    if (lastIssueChange.groupId !== selectedGroupId) return
    loadIssues()
    if (lastIssueChange.issueId === selectedIssueId) {
      setSelectedIssueVersion(v => v + 1)
    }
  }, [lastIssueChange, selectedGroupId, selectedIssueId, loadIssues])

  const handleAddMembers = async (memberNames: string[]) => {
    if (!selectedGroupId) return
    try {
      await groupsApi.addMembers(selectedGroupId, memberNames)
      setShowAddMemberModal(false)
      loadGroups()
    } catch (error) {
      console.error('Failed to add members:', error)
    }
  }

  const retrySelfJoin = useCallback(async () => {
    if (!selfJoinError) return
    const gid = selfJoinError.groupId
    setSelfJoinError(null)
    try {
      await groupsApi.addMembers(gid, [myAgentName])
      await loadGroups()
    } catch {
      setSelfJoinError({ groupId: gid, message: '入群仍然失败，请刷新页面' })
    }
  }, [selfJoinError, myAgentName, loadGroups])

  const handleDeleteDm = async () => {
    const dmGroupId = localStorage.getItem('dm_active_group')
    if (!dmGroupId) return
    if (!confirm(`确定删除与 ${directTargetResolved} 的对话吗？该对话的所有消息会被清除。`)) return
    try {
      await groupsApi.delete(dmGroupId)
      localStorage.removeItem('dm_active_group')
      localStorage.removeItem('dm_active_target')
      localStorage.removeItem('group_selected_id')
      setDirectTarget('')
      navigate('/dashboard/groups')
      loadGroups()
    } catch (error) {
      console.error('Failed to delete DM:', error)
      window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleCreateIssue = async (data: {
    description: string
    title?: string
    priority?: string
    assignedTo?: string
  }) => {
    if (!selectedGroupId) return
    try {
      const result = await issuesApi.create(selectedGroupId, {
        description: data.description,
        title: data.title,
        priority: data.priority as any,
        createdBy: myAgentName,
      })
      if (data.assignedTo && result.id) {
        await issuesApi.update(result.id, { assignedTo: data.assignedTo })
      }
      loadIssues()
    } catch (error) {
      console.error('Failed to create issue:', error)
    }
  }

  // Issue 详情点击 artifact 路径 → 切到含 artifact 的模式(优先保留 process)。
  // 当前是 chat-process → 切到 process-artifact;当前是 chat-artifact 不变;
  // 当前是 process-artifact 不变。
  const handleArtifactClick = useCallback((path: string) => {
    setArtifactSelectedPath(path)
    setMode(prev => {
      if (prev === 'chat-artifact' || prev === 'process-artifact') return prev
      return 'process-artifact'
    })
  }, [])

  return { loadIssues, handleAddMembers, retrySelfJoin, handleDeleteDm, handleCreateIssue, handleArtifactClick }
}
