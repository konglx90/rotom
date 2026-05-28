import { Button } from '../../components/ui/Button'
import type { ConnectionStatus } from './useGroupChatWebSocket'
import styles from './ChatArea.module.css'

interface ConnectionBarProps {
  connectionStatus: ConnectionStatus
  myAgentName: string
  onReconnect: () => void
}

export function ConnectionBar({ connectionStatus, myAgentName, onReconnect }: ConnectionBarProps) {
  return (
    <div className={styles.connectionBar}>
      <div className={`${styles.statusDot} ${styles[connectionStatus]}`} />
      <span>
        {connectionStatus === 'connected' ? '已连接' :
         connectionStatus === 'connecting' ? '连接中...' :
         connectionStatus === 'conflict' ? '连接已被其他页面接管' :
         '未连接'}
      </span>
      {connectionStatus === 'conflict' && (
        <Button variant="ghost" size="sm" onClick={onReconnect}>重新连接</Button>
      )}
      <span style={{ marginLeft: 'auto' }}>当前身份: {myAgentName || '未配置'}</span>
    </div>
  )
}
