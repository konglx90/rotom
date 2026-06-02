import { Navigate, Routes, Route } from 'react-router-dom'
import { ChatProvider, useChatContext } from './context/ChatContext'
import { SocketProvider } from './context/SocketContext'
import { ZenModeProvider } from './context/ZenModeContext'
import { AppShell } from './components/layout/AppShell/AppShell'
import { AgentsView } from './features/agents/AgentsView'
import { GroupChatView } from './features/groups/GroupChatView'
import { IssueDetailPage } from './features/groups/IssueDetailPage'
import { IssuesListPage } from './features/groups/IssuesListPage'
import { KanbanView } from './features/kanban/KanbanView'
import { MessagesView } from './features/messages/MessagesView'
import { TerminalPage } from './features/terminal/TerminalPage'
import { ConfigModal } from './features/groups/modals/ConfigModal'
import { CreateGroupModal } from './features/groups/modals/CreateGroupModal'
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
function RequireAgent({ children }: { children: React.ReactNode }) {
  const { myAgentName } = useChatContext()
  if (!myAgentName) return <Navigate to="/dashboard/agents" replace />
  return <>{children}</>
}

function App() {
  return (
    <ZenModeProvider>
      <ChatProvider>
        <SocketProvider>
          <AppShell>
            <Routes>
              <Route path="/dashboard/agents" element={<div className="container-full"><AgentsView /></div>} />
              <Route path="/dashboard/kanban" element={<RequireAgent><div className="container-full"><KanbanView /></div></RequireAgent>} />
              <Route path="/dashboard/messages" element={<RequireAgent><div className="container-full"><MessagesView /></div></RequireAgent>} />
              <Route path="/dashboard/groups" element={<RequireAgent><div className="container-full"><GroupChatView /></div></RequireAgent>} />
              <Route path="/dashboard/groups/:groupId" element={<RequireAgent><div className="container-full"><GroupChatView /></div></RequireAgent>} />
              <Route path="/dashboard/groups/:groupId/issues/:issueId" element={<RequireAgent><div className="container-full"><GroupChatView /></div></RequireAgent>} />
              <Route path="/dashboard/groups/:groupId/issues-single" element={<RequireAgent><div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><IssuesListPage /></div></RequireAgent>} />
              <Route path="/dashboard/groups/:groupId/issues-single/:issueId" element={<RequireAgent><div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><IssueDetailPage /></div></RequireAgent>} />
              <Route path="/dashboard/terminal" element={<div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><TerminalPage /></div>} />
              <Route path="/dashboard" element={<Navigate to="/dashboard/agents" replace />} />
              <Route path="*" element={<Navigate to="/dashboard/agents" replace />} />
            </Routes>
          </AppShell>
          <ChatModalsHost />
        </SocketProvider>
      </ChatProvider>
    </ZenModeProvider>
  )
}

export default App
