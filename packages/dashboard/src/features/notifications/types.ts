// 卡片式通知系统类型定义。
// 一张卡片 = 类型 + 标题 + 可选描述 + 可选操作按钮 + 自动消失时长。

export type NotificationKind = 'success' | 'error' | 'warning' | 'info'

export interface NotificationAction {
  label: string
  onClick: () => void
  /** primary 用白底深字(强调动作),非 primary 用半透明白描边(次要动作)。 */
  primary?: boolean
}

export interface NotificationPayload {
  id: string
  kind: NotificationKind
  title: string
  description?: string
  /** 自动消失毫秒数。不传 → 按类型默认值;传 0 → 不自动消失(需用户手动关)。 */
  duration?: number
  actions?: NotificationAction[]
  createdAt: number
}

/** 创建通知时传入的选项(id / kind / createdAt 由 Provider 注入)。 */
export type NotificationOptions = Partial<Omit<NotificationPayload, 'id' | 'kind' | 'createdAt'>>

export interface NotificationApi {
  success: (title: string, opts?: NotificationOptions) => string
  error: (title: string, opts?: NotificationOptions) => string
  warning: (title: string, opts?: NotificationOptions) => string
  info: (title: string, opts?: NotificationOptions) => string
  /** 关闭指定通知。 */
  dismiss: (id: string) => void
  /** 清空所有通知。 */
  clear: () => void
}

/** 各类型默认自动消失时长(毫秒)。error 默认不消失。 */
export const DEFAULT_DURATION_MS: Record<NotificationKind, number> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: 0,
}

/** 同时最多可见卡片数。超出进入等待队列,前面的消失后自动补位。 */
export const MAX_VISIBLE = 3
