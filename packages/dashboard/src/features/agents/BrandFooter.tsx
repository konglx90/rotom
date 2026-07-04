import styles from './BrandFooter.module.css'

export function BrandFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.brandMark}>
        <img src="/dashboard/rotom-avatar.png" alt="Rotom" />
      </div>

      <div className={styles.content}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Rotom · 个人 OPC + 团队联邦</h2>
          <span className={styles.version}>v2.19.0</span>
        </div>

        <p className={styles.tagline}>
          每台机器一个 master + executor,开箱即用、免 token、断网可用(个人 OPC)。
          多台机器可联邦成团队 —— 协调 master 星型中转,member 主动接入,
          本机 agent 自动发布可见性,跨机消息经协调路由。数据归属本地,移动电脑切网无感。
        </p>

        <div className={styles.highlights}>
          <span className={styles.pill}><span className={styles.dot} />个人 OPC</span>
          <span className={styles.pill}><span className={styles.dot} />免 token 本机信任</span>
          <span className={styles.pill}><span className={styles.dot} />CLI 自动注册</span>
          <span className={styles.pill}><span className={styles.dot} />团队联邦</span>
          <span className={styles.pill}><span className={styles.dot} />多 CLI 接入</span>
          <span className={styles.pill}><span className={styles.dot} />抢单执行</span>
        </div>

        <div className={styles.meta}>
          <span>© {new Date().getFullYear()} Rotom Mesh</span>
          <span className={styles.divider}>·</span>
          <span>masterId 持久稳定 · hostname 禁 IP</span>
          <span className={styles.divider}>·</span>
          <a href="https://github.com" target="_blank" rel="noreferrer">Docs</a>
        </div>
      </div>
    </footer>
  )
}
