// GroupChatView 的 modal 编排:6 个业务 modal + 2 个 createDialog。
// 纯展示型,所有 show* 状态 + 回调由父组件传入。从 GroupChatView.tsx 抽出。
import { notesApi } from '../../api/notes'
import type { Agent, Group } from '../../api/types'
import { AddMemberModal } from './modals/AddMemberModal'
import { MemberListModal } from './modals/MemberListModal'
import { ShareLinkModal } from './ShareLinkModal'
import { GroupMessageStreamModal } from './modals/GroupMessageStreamModal'
import { GroupSettingsModal } from './modals/GroupSettingsModal'
import { CreateIssueDialog } from './CreateIssueDialog'
import { CreateNoteDialog } from './CreateNoteDialog'
import { Modal } from '../../components/ui/Modal/Modal'
import { SessionPanel } from './SessionPanel'

type CreateDialog = { kind: 'issue' } | { kind: 'note' } | null

interface GroupChatModalsProps {
  selectedGroup: Group | undefined
  selectedGroupId: string
  isDirectMode: boolean
  groupMembers: string[]
  agents: Agent[]
  groups: Group[]
  myAgentName: string
  showAddMemberModal: boolean
  setShowAddMemberModal: (v: boolean) => void
  showMemberList: boolean
  setShowMemberList: (v: boolean) => void
  showShareModal: boolean
  setShowShareModal: (v: boolean) => void
  showGroupSettings: boolean
  setShowGroupSettings: (v: boolean) => void
  showDebugModal: boolean
  setShowDebugModal: (v: boolean) => void
  showGroupMessagesModal: boolean
  setShowGroupMessagesModal: (v: boolean) => void
  createDialog: CreateDialog
  setCreateDialog: (v: CreateDialog) => void
  handleAddMembers: (memberNames: string[]) => Promise<void>
  handleCreateIssue: (data: { description: string; title?: string; priority?: string; assignedTo?: string }) => Promise<void>
  updateGroupGuidancePrompt: (groupId: string, prompt: string | null) => Promise<void>
  updateGroupName: (groupId: string, name: string) => Promise<void>
  updateGroupWorkingDir: (groupId: string, workingDir: string | null) => Promise<void>
  updateGroupRepo: (groupId: string, data: {
    repoUrl: string | null
    repoDefaultBranch: string | null
    extraRepos: Array<{ id: string; url: string; branch?: string; mountPath: string }> | null
    worktreeMode?: 'group' | 'issue' | null
  }) => Promise<void>
  setGroupMemberWorkingDir: (groupId: string, agentName: string, workingDir: string) => Promise<void>
  clearGroupMemberWorkingDir: (groupId: string, agentName: string) => Promise<void>
  loadGroups: () => Promise<void>
}

export function GroupChatModals({
  selectedGroup,
  selectedGroupId,
  isDirectMode,
  groupMembers,
  agents,
  groups,
  myAgentName,
  showAddMemberModal,
  setShowAddMemberModal,
  showMemberList,
  setShowMemberList,
  showShareModal,
  setShowShareModal,
  showGroupSettings,
  setShowGroupSettings,
  showDebugModal,
  setShowDebugModal,
  showGroupMessagesModal,
  setShowGroupMessagesModal,
  createDialog,
  setCreateDialog,
  handleAddMembers,
  handleCreateIssue,
  updateGroupGuidancePrompt,
  updateGroupName,
  updateGroupWorkingDir,
  updateGroupRepo,
  setGroupMemberWorkingDir,
  clearGroupMemberWorkingDir,
  loadGroups,
}: GroupChatModalsProps) {
  return (
    <>
      <AddMemberModal
        key={selectedGroup?.id ?? 'no-group'}
        open={showAddMemberModal}
        groupMemberNames={groupMembers}
        agents={agents}
        onClose={() => setShowAddMemberModal(false)}
        onAdd={handleAddMembers}
      />

      {/* 群模式:成员列表 modal(从原 chatHeader 上移)。
          key=groupId:切群时强制 remount,清空内部 group-scoped state(guidanceValue/editingDir 等),
          否则切群后残留上一群的编辑态。 */}
      {selectedGroup && !isDirectMode && (
        <MemberListModal
          key={selectedGroup.id}
          open={showMemberList}
          members={selectedGroup.members || []}
          agents={agents}
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          groupWorkingDir={selectedGroup.working_dir ?? null}
          groupGuidancePrompt={selectedGroup.guidance_prompt ?? null}
          onUpdateGuidancePrompt={updateGroupGuidancePrompt}
          onClose={() => setShowMemberList(false)}
          onUpdateMemberWorkingDir={async (gid, agentName, dir) => {
            if (dir === null) {
              await clearGroupMemberWorkingDir(gid, agentName)
            } else {
              await setGroupMemberWorkingDir(gid, agentName, dir)
            }
          }}
          onProfilesChanged={loadGroups}
        />
      )}

      {/* 群模式:分享链接 modal(从原 chatHeader 上移)。 */}
      {showShareModal && selectedGroup && !isDirectMode && (
        <ShareLinkModal
          key={selectedGroup.id}
          open
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {/* Sessions 调试 modal:从 ArtifactPanel 底部搬过来,腾出垂直空间。 */}
      {/* 群设置 modal:群聊界面内的群配置入口(名称/工作目录/指导 prompt/内置 repo worktree/技能绑定)。
          复用侧边栏同一组件;update* 回调内部 loadGroups,保存后自动刷新群数据。 */}
      {showGroupSettings && selectedGroup && !isDirectMode && (
        <GroupSettingsModal
          key={selectedGroup.id}
          open
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          groupWorkingDir={selectedGroup.working_dir ?? null}
          groupGuidancePrompt={selectedGroup.guidance_prompt ?? null}
          groupRepoUrl={selectedGroup.repo_url ?? null}
          groupRepoDefaultBranch={selectedGroup.repo_default_branch ?? null}
          groupExtraRepos={selectedGroup.extra_repos ?? null}
          groupWorktreeMode={selectedGroup.worktree_mode ?? null}
          memberAgentNames={(selectedGroup.members ?? []).map((m) => m.agent_name)}
          onClose={() => setShowGroupSettings(false)}
          onSaveName={(name) => updateGroupName(selectedGroup.id, name)}
          onSaveWorkingDir={(dir) => updateGroupWorkingDir(selectedGroup.id, dir)}
          onSaveGuidancePrompt={(prompt) => updateGroupGuidancePrompt(selectedGroup.id, prompt)}
          onSaveRepo={(data) => updateGroupRepo(selectedGroup.id, data)}
        />
      )}

      {showDebugModal && selectedGroup && (
        <Modal
          open
          title={`🔧 Sessions · ${selectedGroup.name}`}
          onClose={() => setShowDebugModal(false)}
          size="lg"
        >
          <SessionPanel groupId={selectedGroup.id} />
        </Modal>
      )}

      {/* 当前群消息流 modal:锁定当前群,群不可切换。 */}
      {showGroupMessagesModal && selectedGroup && !isDirectMode && (
        <GroupMessageStreamModal
          open
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          groups={groups}
          onClose={() => setShowGroupMessagesModal(false)}
        />
      )}

      {createDialog?.kind === 'issue' && selectedGroupId && (
        <CreateIssueDialog
          open
          agents={agents}
          onClose={() => setCreateDialog(null)}
          onCreateIssue={(data) => {
            handleCreateIssue(data)
            setCreateDialog(null)
          }}
        />
      )}

      {createDialog?.kind === 'note' && selectedGroupId && (
        <CreateNoteDialog
          open
          onClose={() => setCreateDialog(null)}
          onCreate={async (data) => {
            try {
              await notesApi.create(selectedGroupId, {
                title: data.title,
                description: data.description,
                createdBy: myAgentName,
              })
              setCreateDialog(null)
            } catch (err) {
              console.error('Failed to create note:', err)
              window.alert(`创建失败：${err instanceof Error ? err.message : String(err)}`)
            }
          }}
        />
      )}
    </>
  )
}
