import type { Group } from '../../../api/types'
import { Modal } from '../../../components/ui/Modal/Modal'
import { MessageStream } from '../../messages/MessageStream'

interface Props {
  open: boolean
  groupId: string
  groupName?: string
  groups: Group[]
  onClose: () => void
}

// modeSidebar 群消息流弹窗:锁定当前群,群不可切换。
// 复用 messages 模块的 MessageStream,通过 lockGroupId 隐藏群下拉并强制 groupId。
export function GroupMessageStreamModal({ open, groupId, groupName, groups, onClose }: Props) {
  return (
    <Modal open={open} title={groupName ? `群消息流 · ${groupName}` : '群消息流'} onClose={onClose} size="xl">
      <MessageStream lockGroupId={groupId} groups={groups} />
    </Modal>
  )
}
