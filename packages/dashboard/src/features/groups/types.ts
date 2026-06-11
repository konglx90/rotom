export interface ChatMessage {
  id: string
  from: string
  content: string
  timestamp: Date
  isIncoming: boolean
  mentions?: string[]
  streaming?: boolean
  isLoading?: boolean
  /** Delivery status for outgoing messages. Incoming messages leave this undefined. */
  status?: 'pending' | 'delivered' | 'queued' | 'failed'
  /** Server error when status === 'failed'. */
  statusError?: string
  /** Cwd the sending agent was using when producing this message. */
  cwd?: string
}

export interface ServerMessage {
  type: 'a2a_message' | 'directory_update' | 'auth_ok' | 'auth_fail' | 'route_result' | 'a2a_stream_chunk' | 'a2a_stream_end' | 'heartbeat_ack' | 'issue_changed'
  requestId?: string
  from?: { name: string; domain?: string; status: string }
  payload?: { message: string }
  message?: string
  delivered?: boolean
  queued?: boolean
  error?: string
  reason?: string
  delta?: string
  event?: 'join' | 'leave' | 'update'
  issueId?: string
  groupId?: string
  kind?: 'created' | 'updated' | 'event_appended' | 'deleted'
  conversation?: { type: 'single' | 'group'; groupId?: string; groupName?: string }
  agent?: { name: string; domain?: string; status: 'online' | 'offline' }
  /** Cwd the upstream agent reported. Filled in for a2a_message / a2a_stream_end. */
  cwd?: string
}

export const DM_GROUP_PREFIX = '__dm__:'

export function getDmTargetFromGroupName(name: string): string | null {
  if (!name.startsWith(DM_GROUP_PREFIX)) return null
  const parts = name.slice(DM_GROUP_PREFIX.length).split(':')
  return parts[0] || null
}

export function generateDmGroupName(targetName: string, existingCount: number): string {
  return `${DM_GROUP_PREFIX}${targetName}:${existingCount + 1}`
}

export function extractMentions(text: string): string[] {
  const matches = text.match(/@([\w一-鿿][\w.一-鿿-]*)/g)
  return matches ? matches.map(m => m.slice(1)) : []
}
