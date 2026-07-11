/**
 * Shared "open terminals" state — the single source of truth that both the
 * inline group TerminalPane and the global TerminalDeck read from and write to.
 *
 * A terminal is "open" if its group id is in `openIds`. Opening it anywhere
 * (expanding the inline pane, clicking + 添加 in the deck) adds it; closing it
 * anywhere removes it. That's what makes the two surfaces "通的": expanding a
 * terminal inside a group makes it show up in the global deck, and vice versa.
 *
 * The deck grid renders only the first MAX_VISIBLE (most-recent-first); the
 * rest are "hidden" but reachable via an overflow switcher. `openIds` and the
 * deck's open/closed state are persisted to localStorage. PTYs themselves
 * persist server-side (keyed by group id), so closing/reloading only detaches.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export const MAX_VISIBLE = 4

const OPEN_IDS_KEY = 'terminal_deck_open_ids'
const OPEN_KEY = 'terminal_deck_open'

interface TerminalDeckContextValue {
  /** Floating deck overlay open/closed. */
  open: boolean
  /** All open terminals, most-recent-first. */
  openIds: string[]
  /** The slice rendered in the deck grid (≤ MAX_VISIBLE). */
  visibleIds: string[]
  /** Open terminals beyond the grid — reachable via the overflow switcher. */
  hiddenIds: string[]
  setOpen: (v: boolean) => void
  toggle: () => void
  isTerminalOpen: (groupId: string) => boolean
  /** Move to front (add if absent). Used by inline expand, deck "+ 添加",
   *  and clicking an overflow chip to bring a hidden terminal into view. */
  openTerminal: (groupId: string) => void
  closeTerminal: (groupId: string) => void
}

const TerminalDeckContext = createContext<TerminalDeckContextValue>({
  open: false,
  openIds: [],
  visibleIds: [],
  hiddenIds: [],
  setOpen: () => {},
  toggle: () => {},
  isTerminalOpen: () => false,
  openTerminal: () => {},
  closeTerminal: () => {},
})

function readOpenIds(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_IDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.filter((x) => typeof x === 'string')))
  } catch {
    return []
  }
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

export function TerminalDeckProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState<boolean>(readOpen)
  const [openIds, setOpenIds] = useState<string[]>(readOpenIds)

  useEffect(() => {
    try { localStorage.setItem(OPEN_IDS_KEY, JSON.stringify(openIds)) } catch { /* quota */ }
  }, [openIds])

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* quota */ }
  }, [open])

  const setOpen = useCallback((v: boolean) => setOpenState(v), [])
  const toggle = useCallback(() => setOpenState((v) => !v), [])
  const isTerminalOpen = useCallback((id: string) => openIds.includes(id), [openIds])

  // Move-to-front (add if absent). Does NOT force the overlay open — expanding
  // an inline pane shouldn't pop the floating deck; the user opens that via ⌨.
  const openTerminal = useCallback((id: string) => {
    if (!id) return
    setOpenIds((prev) => (prev[0] === id ? prev : [id, ...prev.filter((x) => x !== id)]))
  }, [])

  const closeTerminal = useCallback((id: string) => {
    setOpenIds((prev) => prev.filter((x) => x !== id))
  }, [])

  const visibleIds = useMemo(() => openIds.slice(0, MAX_VISIBLE), [openIds])
  const hiddenIds = useMemo(() => openIds.slice(MAX_VISIBLE), [openIds])

  const value = useMemo<TerminalDeckContextValue>(
    () => ({ open, openIds, visibleIds, hiddenIds, setOpen, toggle, isTerminalOpen, openTerminal, closeTerminal }),
    [open, openIds, visibleIds, hiddenIds, setOpen, toggle, isTerminalOpen, openTerminal, closeTerminal],
  )

  return <TerminalDeckContext.Provider value={value}>{children}</TerminalDeckContext.Provider>
}

export function useTerminalDeck() {
  return useContext(TerminalDeckContext)
}
