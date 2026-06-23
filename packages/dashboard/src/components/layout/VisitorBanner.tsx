import styles from './VisitorBanner.module.css'

/**
 * Top banner shown when the dashboard is in visitor mode (URL has
 * `?share=<token>` and the token was validated). Tells the user they have
 * read-only access and how they got here.
 */
export function VisitorBanner({ groupName }: { groupName?: string }) {
  return (
    <div role="status" className={styles.visitorBanner}>
      <span className={styles.visitorIcon} aria-hidden>👁</span>
      <span className={styles.visitorTitle}>访客模式</span>
      <span className={styles.visitorText}>
        {groupName
          ? `正在只读查看「${groupName}」`
          : '正在只读查看分享内容'}
        ，无法发送消息或修改任何内容
      </span>
    </div>
  )
}