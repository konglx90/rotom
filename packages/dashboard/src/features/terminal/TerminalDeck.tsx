/**
 * Global multi-terminal deck — a right-docked overlay showing up to
 * MAX_VISIBLE group terminals side by side. Mounted once in AppShell (sibling
 * of <main>), so it never unmounts on group/route changes; PTYs persist
 * server-side keyed by group id.
 *
 * The set of open terminals is shared with the inline group TerminalPane via
 * TerminalDeckContext. The grid renders the most-recent MAX_VISIBLE; any
 * further open terminals appear as overflow chips you can click to swap into
 * the grid. XTermView auto-reconnects, so there's no manual "重连" button.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/ui/Button'
import { useChatContext } from '../../context/ChatContext'
import { XTermView, type TerminalStatus } from './XTermView'
import { groupTerminalUrl } from './terminalUrl'
import { MAX_VISIBLE, useTerminalDeck } from './TerminalDeckContext'
import styles from './TerminalDeck.module.css'

export function TerminalDeck() {
  const { open, setOpen, openIds, visibleIds, hiddenIds } = useTerminalDeck()
  if (!open) return null

  // 1 visible → full-width single column; ≥2 → 2-column grid (a lone terminal
  // gets the whole panel instead of being squeezed to half width).
  const gridClass = visibleIds.length >= 2 ? styles.grid2 : styles.grid1

  return (
    <div className={styles.overlay} role="dialog" aria-label="终端面板">
      <div className={styles.panel}>
        <header className={styles.header}>
          <span className={styles.title}>
            终端
            <span className={styles.count}>
              {' '}{openIds.length} 个{hiddenIds.length > 0 ? ` · 同屏 ${MAX_VISIBLE}` : ''}
            </span>
          </span>
          <div className={styles.headerActions}>
            <AddSlotMenu />
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} title="收起（终端在后台继续运行）">
              收起
            </Button>
          </div>
        </header>

        {hiddenIds.length > 0 && <OverflowRow ids={hiddenIds} />}

        {openIds.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>⌨</div>
            <p className={styles.emptyText}>还没有终端。点右上「添加」选一个群，或在某个群里展开终端。</p>
            <p className={styles.emptyHint}>同屏最多 {MAX_VISIBLE} 个，其余可随时切回。每个 shell 后台常驻，切群 / 收起都不会断。</p>
          </div>
        ) : (
          <div className={`${styles.grid} ${gridClass}`}>
            {visibleIds.map((groupId) => (
              <DeckCell key={groupId} groupId={groupId} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** A single group terminal cell: header (name + status + close) + xterm. */
function DeckCell({ groupId }: { groupId: string }) {
  const { groups } = useChatContext()
  const { closeTerminal } = useTerminalDeck()
  const group = groups.find((g) => g.id === groupId)
  const name = group?.name ?? groupId

  const [status, setStatus] = useState<TerminalStatus>('closed')
  const url = useMemo(() => groupTerminalUrl(groupId), [groupId])

  const statusLabel =
    status === 'open' ? '● 已连接' : status === 'connecting' ? '○ 连接中' : '× 已断开'
  const statusClass =
    status === 'open' ? styles.statusOk : status === 'connecting' ? styles.statusPending : styles.statusBad

  return (
    <div className={styles.cell}>
      <div className={styles.cellHeader}>
        <span className={styles.cellName} title={name}>{name}</span>
        <span className={`${styles.cellStatus} ${statusClass}`}>{statusLabel}</span>
        <div className={styles.cellActions}>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            title="关闭（shell 后台保留至空闲回收）"
            onClick={() => closeTerminal(groupId)}
          >
            ✕
          </Button>
        </div>
      </div>
      <XTermView url={url} connectToken={0} onStatusChange={setStatus} className={styles.cellTerm} />
    </div>
  )
}

/** Overflow row: open terminals beyond the MAX_VISIBLE grid. Click to swap
 *  one into the grid (most-recent-first evicts the oldest visible slot). */
function OverflowRow({ ids }: { ids: string[] }) {
  const { groups } = useChatContext()
  const { openTerminal, closeTerminal } = useTerminalDeck()
  return (
    <div className={styles.overflow}>
      <span className={styles.overflowLabel}>未展示({ids.length}),点击切换:</span>
      {ids.map((id) => {
        const name = groups.find((g) => g.id === id)?.name ?? id
        return (
          <span key={id} className={styles.chip}>
            <button
              type="button"
              className={styles.chipBtn}
              onClick={() => openTerminal(id)}
              title={`切到「${name}」(占一个展示位)`}
            >
              {name}
            </button>
            <button
              type="button"
              className={styles.chipClose}
              onClick={() => closeTerminal(id)}
              title="关闭"
            >
              ✕
            </button>
          </span>
        )
      })}
    </div>
  )
}

/** "+ 添加" picker: lists groups whose terminal isn't open yet. */
function AddSlotMenu() {
  const { groups } = useChatContext()
  const { isTerminalOpen, openTerminal } = useTerminalDeck()
  const [menuOpen, setMenuOpen] = useState(false)

  // Close on Escape; outside-click handled by the backdrop rendered below.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const available = groups.filter((g) => !isTerminalOpen(g.id) && g.type !== 'direct')

  return (
    <div className={styles.addWrap}>
      <Button
        variant="ghost"
        size="sm"
        disabled={available.length === 0}
        onClick={() => setMenuOpen((v) => !v)}
        title="添加一个群的终端"
      >
        + 添加
      </Button>
      {menuOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setMenuOpen(false)} />
          <div className={styles.menu}>
            {available.length === 0 ? (
              <div className={styles.menuEmpty}>没有可添加的群</div>
            ) : (
              available.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    openTerminal(g.id)
                    setMenuOpen(false)
                  }}
                >
                  <span className={styles.menuName}>{g.name}</span>
                  {g.type ? <span className={styles.menuType}>{g.type}</span> : null}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
