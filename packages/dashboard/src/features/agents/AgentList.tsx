import type { Agent } from '../../api/types'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Avatar } from '../../components/ui/Avatar'
import { AsyncBoundary } from '../../components/async/AsyncBoundary'
import { useAgents } from '../../hooks/useAgents'
import styles from './AgentList.module.css'

export function AgentList() {
  const { agents, loading, error, refetch } = useAgents()

  return (
    <AsyncBoundary
      data={agents}
      loading={loading}
      error={error}
      isEmpty={(data) => data.length === 0}
      onRetry={refetch}
      loadingFallback={
        <div className={styles.loading}>
          <div className={styles.spinner}></div>
          <p>加载员工数据...</p>
        </div>
      }
      errorFallback={(err, retry) => (
        <div className={styles.error}>
          <p>❌ 加载失败: {typeof err === 'string' ? err : err.message}</p>
          <Button variant="ghost" size="sm" onClick={retry}>重试</Button>
        </div>
      )}
      emptyFallback={
        <div className={styles.empty}>
          <p>暂无员工数据</p>
          <p className={styles.hint}>请先注册员工</p>
        </div>
      }
    >
      {(data) => <AgentListContent agents={data} />}
    </AsyncBoundary>
  )
}

interface AgentListContentProps {
  agents: Agent[]
}

function AgentListContent({ agents }: AgentListContentProps) {
  const onlineCount = agents.filter(a => a.status === 'online').length
  const offlineCount = agents.length - onlineCount

  return (
    <div className={styles.container}>
      {/* Stats Cards */}
      <div className={styles.stats}>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{agents.length}</div>
          <div className={styles.statLabel}>总员工数</div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statValue} ${styles.online}`}>{onlineCount}</div>
          <div className={styles.statLabel}>在线</div>
        </div>
        <div className={styles.statCard}>
          <div className={`${styles.statValue} ${styles.offline}`}>{offlineCount}</div>
          <div className={styles.statLabel}>离线</div>
        </div>
      </div>

      {/* Agent List */}
      <div className={styles.list}>
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  )
}

interface AgentCardProps {
  agent: Agent
}

function AgentCard({ agent }: AgentCardProps) {
  const isOnline = agent.status === 'online'

  return (
    <div className={`${styles.card} ${isOnline ? styles.online : styles.offline}`}>
      <div className={styles.cardHeader}>
        <Avatar name={agent.name} src={agent.avatar_url} size={40} />
        <div className={styles.cardInfo}>
          <h3 className={styles.name}>{agent.name}</h3>
          <div className={styles.meta}>
            <Badge tone="status" value={isOnline ? 'completed' : 'cancelled'}>
              {isOnline ? '在线' : '离线'}
            </Badge>
            {agent.domain && <Badge tone="tag">{agent.domain}</Badge>}
          </div>
        </div>
        <div className={styles.status}>
          <div className={`${styles.dot} ${isOnline ? styles.dotOnline : styles.dotOffline}`}></div>
        </div>
      </div>

      {agent.description && (
        <p className={styles.description}>{agent.description}</p>
      )}

      {agent.profile && (agent.profile.position || agent.profile.bio) && (
        <div className={styles.profileTags}>
          {agent.profile.position && <Badge tone="tag">{agent.profile.position}</Badge>}
          {agent.profile.bio && (
            <Badge tone="tag" className={styles.techBadge}>{agent.profile.bio}</Badge>
          )}
        </div>
      )}

      {agent.message_stats && (
        <div className={styles.metrics}>
          <div className={styles.metric}>
            <span className={styles.metricValue}>{agent.message_stats.sent}</span>
            <span className={styles.metricLabel}>发送</span>
          </div>
          <div className={styles.metric}>
            <span className={styles.metricValue}>{agent.message_stats.received}</span>
            <span className={styles.metricLabel}>接收</span>
          </div>
          {agent.message_stats.avg_latency_ms > 0 && (
            <div className={styles.metric}>
              <span className={styles.metricValue}>
                {(agent.message_stats.avg_latency_ms / 1000).toFixed(2)}s
              </span>
              <span className={styles.metricLabel}>平均延迟</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
