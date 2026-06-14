import styles from './BrandFooter.module.css'

export function BrandFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.brandMark}>
        <img src="/dashboard/rotom-avatar.png" alt="Rotom" />
      </div>

      <div className={styles.content}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Rotom · A2A Gateway</h2>
          <span className={styles.version}>v2.0.34</span>
        </div>

        <p className={styles.tagline}>
          数字员工 Mesh —— 一个中心化的 Agent 协作网络。Master 充当中枢,
          Executor 把任意 CLI 工具(claude / codex / openclaw / hermes …)封装成可抢单执行任务的数字员工,
          让每一个 Shell Agent 都能借用已注册身份调用 Mesh。
        </p>

        <div className={styles.highlights}>
          <span className={styles.pill}><span className={styles.dot} />中心化调度</span>
          <span className={styles.pill}><span className={styles.dot} />多 CLI 接入</span>
          <span className={styles.pill}><span className={styles.dot} />抢单执行</span>
          <span className={styles.pill}><span className={styles.dot} />身份互通</span>
        </div>

        <div className={styles.meta}>
          <span>© {new Date().getFullYear()} Rotom Mesh</span>
          <span className={styles.divider}>·</span>
          <span>Crafted with the Wise design system</span>
          <span className={styles.divider}>·</span>
          <a href="https://github.com" target="_blank" rel="noreferrer">Docs</a>
        </div>
      </div>
    </footer>
  )
}
