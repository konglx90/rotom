// header「VSCode」按钮的下拉菜单:让用户选开产物目录还是某个仓库 worktree。
// 仓库目录往往比产物目录更重要(agent 改代码改的是仓库),所以做成下拉让用户挑。
// 自包含:menuOpen 状态 + 点击外部/ESC 关闭 effect 都在这里。
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { repoDisplayName } from './BranchDiffControls'
import type { GroupWorktreeInfo } from '../../../api/repos'
import styles from './ArtifactPanel.module.css'

interface VscodeMenuProps {
  groupWorktree: GroupWorktreeInfo | null
  vscodeLoading: boolean
  root: string | null
  onOpenVscode: (filePath?: string, repo?: string) => void
}

export function VscodeMenu({ groupWorktree, vscodeLoading, root, onOpenVscode }: VscodeMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div className={styles.vscodeDropdown} ref={menuRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={vscodeLoading}
        title="在 master 本机用 VSCode 打开:产物目录或某个仓库 worktree"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {vscodeLoading ? 'VSCode…' : 'VSCode'}{'\u{25BE}'}
      </Button>
      {menuOpen && (
        <div className={styles.vscodeMenu} role="menu">
          <button
            type="button"
            className={styles.vscodeMenuItem}
            onClick={() => {
              setMenuOpen(false)
              void onOpenVscode()
            }}
            title={`产物目录 · ${root || ''}`}
          >
            <span className={styles.vscodeMenuIcon}>{'\u{1F4E6}'}</span>
            <span className={styles.vscodeMenuLabel}>产物目录</span>
          </button>
          {groupWorktree && (
            <>
              <div className={styles.vscodeMenuSeparator} />
              <button
                type="button"
                className={styles.vscodeMenuItem}
                disabled={!groupWorktree.primaryExists}
                onClick={() => {
                  setMenuOpen(false)
                  void onOpenVscode(undefined, 'primary')
                }}
                title={groupWorktree.primaryPath}
              >
                <span className={styles.vscodeMenuIcon}>{'\u{1F4C1}'}</span>
                <span className={styles.vscodeMenuLabel}>
                  primary · {repoDisplayName(groupWorktree.url)}
                  {!groupWorktree.primaryExists && ' (未创建)'}
                </span>
              </button>
              {groupWorktree.extras.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={styles.vscodeMenuItem}
                  disabled={!e.exists}
                  onClick={() => {
                    setMenuOpen(false)
                    void onOpenVscode(undefined, e.id)
                  }}
                  title={e.path}
                >
                  <span className={styles.vscodeMenuIcon}>{'\u{1F4C1}'}</span>
                  <span className={styles.vscodeMenuLabel}>
                    {e.id} · {repoDisplayName(e.url)}
                    {!e.exists && ' (未创建)'}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
