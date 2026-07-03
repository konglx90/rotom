import { Navigate, Routes, Route } from 'react-router-dom'
import { ChatProvider, useChatContext } from './context/ChatContext'
import { SocketProvider } from './context/SocketContext'
import { WorkSessionProvider } from './context/WorkSessionContext'
import { ZenModeProvider } from './context/ZenModeContext'
import { VisitorProvider, useVisitorMode } from './context/VisitorContext'
import { AppShell } from './components/layout/AppShell/AppShell'
import { AgentsView } from './features/agents/AgentsView'
import { GroupChatView } from './features/groups/GroupChatView'
import { IssueDetailPage } from './features/groups/IssueDetailPage'
import { IssuesListPage } from './features/groups/IssuesListPage'
import { KanbanView } from './features/kanban/KanbanView'
import { MessagesView } from './features/messages/MessagesView'
import { TerminalPage } from './features/terminal/TerminalPage'
import { ToolboxView } from './features/toolbox/ToolboxView'
import { PromptsManagementTab } from './features/toolbox/PromptsManagementTab'
import { SchedulePatternsTab } from './features/toolbox/SchedulePatternsTab'
import { MemoryManagementTab } from './features/toolbox/MemoryManagementTab'
import { SkillsManagementTab } from './features/toolbox/SkillsManagementTab'
import { IssuePatrolTab } from './features/toolbox/IssuePatrolTab'
import { LinkPatrolTab } from './features/toolbox/LinkPatrolTab'
import { ImageGalleryTab } from './features/toolbox/ImageGalleryTab'
import { WorktreesTab } from './features/toolbox/WorktreesTab'
import { ConfigModal } from './features/groups/modals/ConfigModal'
import { CreateGroupModal } from './features/groups/modals/CreateGroupModal'
import { NotificationProvider } from './features/notifications/NotificationContext'
import { NotificationHost } from './features/notifications/NotificationHost'
import './styles/App.css'

function ChatModalsHost() {
  const {
    showConfigModal,
    setMyAgentConfig,
    closeConfigModal,
    showCreateGroupModal,
    closeCreateGroupModal,
    createGroup,
    agents,
    myAgentName,
  } = useChatContext()

  return (
    <>
      <ConfigModal open={showConfigModal} onConfigured={setMyAgentConfig} onClose={closeConfigModal} />
      <CreateGroupModal
        open={showCreateGroupModal}
        agents={agents}
        myAgentName={myAgentName}
        onClose={closeCreateGroupModal}
        onCreate={createGroup}
      />
    </>
  )
}

// 路由守卫：未绑定身份时把消息/群聊页统一弹回 /dashboard/agents，
// 避免依赖 WS / 群消息身份的组件在 myAgentName='' 状态下渲染出半坏的 UI。
// 访客模式（?share=<token>）绕过身份检查 —— 访客本来就没有 myAgentName。
function RequireAgent({ children }: { children: React.ReactNode }) {
  const { myAgentName } = useChatContext()
  const { isVisitor } = useVisitorMode()
  if (isVisitor) return <>{children}</>
  if (!myAgentName) return <Navigate to="/dashboard/agents" replace />
  return <>{children}</>
}

function App() {
  return (
    <ZenModeProvider>
      <VisitorProvider>
        <ChatProvider>
          <SocketProvider>
            <NotificationProvider>
            <WorkSessionProvider>
              <AppShell>
              <Routes>
                <Route path="/dashboard/agents" element={<div className="container-full"><AgentsView /></div>} />
                <Route path="/dashboard/kanban" element={<RequireAgent><div className="container-full"><KanbanView /></div></RequireAgent>} />
                <Route path="/dashboard/groups" element={<RequireAgent><div className="container-full"><GroupChatView /></div></RequireAgent>} />
                <Route path="/dashboard/groups/:groupId" element={<RequireAgent><div className="container-full"><GroupChatView /></div></RequireAgent>} />
                <Route path="/dashboard/groups/:groupId/issues/:issueId" element={<RequireAgent><div className="container-full"><GroupChatView /></div></RequireAgent>} />
                <Route path="/dashboard/groups/:groupId/issues-single" element={<RequireAgent><div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><IssuesListPage /></div></RequireAgent>} />
                <Route path="/dashboard/groups/:groupId/issues-single/:issueId" element={<RequireAgent><div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><IssueDetailPage /></div></RequireAgent>} />
                <Route path="/dashboard/toolbox" element={<RequireAgent><div className="container-full"><ToolboxView /></div></RequireAgent>}>
                  <Route index element={<Navigate to="messages" replace />} />
                  <Route path="terminal" element={<TerminalPage />} />
                  <Route path="messages" element={<MessagesView />} />
                  <Route path="prompts" element={<PromptsManagementTab />} />
                  <Route path="schedule-patterns" element={<SchedulePatternsTab />} />
                  <Route path="memory" element={<MemoryManagementTab />} />
                  <Route path="skills" element={<SkillsManagementTab />} />
                  <Route path="issue-patrol" element={<IssuePatrolTab />} />
                  <Route path="link-patrol" element={<LinkPatrolTab />} />
                  <Route path="gallery" element={<ImageGalleryTab />} />
                  <Route path="worktrees" element={<WorktreesTab />} />
                </Route>
                <Route path="/dashboard/messages" element={<Navigate to="/dashboard/toolbox/messages" replace />} />
                <Route path="/dashboard/terminal" element={<Navigate to="/dashboard/toolbox/terminal" replace />} />
                <Route path="/dashboard" element={<Navigate to="/dashboard/agents" replace />} />
                <Route path="*" element={<Navigate to="/dashboard/agents" replace />} />
              </Routes>
              </AppShell>
              <ChatModalsHost />
            </WorkSessionProvider>
            <NotificationHost />
            </NotificationProvider>
          </SocketProvider>
        </ChatProvider>
      </VisitorProvider>
    </ZenModeProvider>
  )
}

export default App