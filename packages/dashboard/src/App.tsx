import { Navigate, Routes, Route } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ChatProvider, useChatContext } from './context/ChatContext'
import { SocketProvider } from './context/SocketContext'
import { ZenModeProvider } from './context/ZenModeContext'
import { LoginForm } from './features/auth/LoginForm'
import { AppShell } from './components/layout/AppShell/AppShell'
import { AgentsView } from './features/agents/AgentsView'
import { GroupChatView } from './features/groups/GroupChatView'
import { IssueDetailPage } from './features/groups/IssueDetailPage'
import { IssuesListPage } from './features/groups/IssuesListPage'
import { MessagesView } from './features/messages/MessagesView'
import { ConfigModal } from './features/groups/modals/ConfigModal'
import { CreateGroupModal } from './features/groups/modals/CreateGroupModal'
import './styles/App.css'

function ChatModalsHost() {
  const {
    showConfigModal,
    setMyAgentConfig,
    showCreateGroupModal,
    closeCreateGroupModal,
    createGroup,
    agents,
    myAgentName,
  } = useChatContext()

  return (
    <>
      <ConfigModal open={showConfigModal} onConfigured={setMyAgentConfig} />
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

function AppContent() {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <div className="loading">
        <div className="spinner"></div>
        <p>加载中...</p>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginForm />
  }

  return (
    <ChatProvider>
      <SocketProvider>
        <AppShell>
          <Routes>
            <Route path="/dashboard/agents" element={<div className="container-full"><AgentsView /></div>} />
            <Route path="/dashboard/messages" element={<div className="container-full"><MessagesView /></div>} />
            <Route path="/dashboard/groups" element={<div className="container-full"><GroupChatView /></div>} />
            <Route path="/dashboard/groups/:groupId" element={<div className="container-full"><GroupChatView /></div>} />
            <Route path="/dashboard/groups/:groupId/issues/:issueId" element={<div className="container-full"><GroupChatView /></div>} />
            <Route path="/dashboard/groups/:groupId/issues-single" element={<div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><IssuesListPage /></div>} />
            <Route path="/dashboard/groups/:groupId/issues-single/:issueId" element={<div className="container-full" style={{ display: 'flex', flexDirection: 'column' }}><IssueDetailPage /></div>} />
            <Route path="/dashboard" element={<Navigate to="/dashboard/agents" replace />} />
            <Route path="*" element={<Navigate to="/dashboard/agents" replace />} />
          </Routes>
        </AppShell>
        <ChatModalsHost />
      </SocketProvider>
    </ChatProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      <ZenModeProvider>
        <AppContent />
      </ZenModeProvider>
    </AuthProvider>
  )
}

export default App
