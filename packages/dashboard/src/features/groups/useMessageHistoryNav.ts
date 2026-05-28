import { useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { getHistory } from './messageHistory'

interface UseMessageHistoryNavParams {
  value: string
  setValue: (v: string) => void
  textareaRef: RefObject<HTMLTextAreaElement>
  disabled?: boolean
}

export function useMessageHistoryNav({
  value,
  setValue,
  textareaRef,
  disabled,
}: UseMessageHistoryNavParams) {
  const indexRef = useRef<number>(-1)
  const draftRef = useRef<string>('')
  const lastSetRef = useRef<string | null>(null)

  function applyAutoHeight(t: HTMLTextAreaElement) {
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 160) + 'px'
  }

  function setAndMoveCursorEnd(next: string) {
    setValue(next)
    lastSetRef.current = next
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      const end = t.value.length
      t.setSelectionRange(end, end)
      applyAutoHeight(t)
    })
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (disabled) return false
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false

    const ta = textareaRef.current
    if (!ta) return false

    if (lastSetRef.current !== null && value !== lastSetRef.current) {
      indexRef.current = -1
      draftRef.current = ''
      lastSetRef.current = null
    }

    const selStart = ta.selectionStart
    const selEnd = ta.selectionEnd
    const atStart = selStart === 0 && selEnd === 0
    const atEnd = selStart === ta.value.length && selEnd === ta.value.length

    const history = getHistory()
    if (history.length === 0) return false

    if (e.key === 'ArrowUp') {
      if (!atStart) return false
      let nextIndex: number
      if (indexRef.current === -1) {
        draftRef.current = value
        nextIndex = history.length - 1
      } else if (indexRef.current > 0) {
        nextIndex = indexRef.current - 1
      } else {
        e.preventDefault()
        return true
      }
      indexRef.current = nextIndex
      e.preventDefault()
      setAndMoveCursorEnd(history[nextIndex])
      return true
    }

    if (!atEnd) return false
    if (indexRef.current === -1) return false

    let next: string
    if (indexRef.current < history.length - 1) {
      indexRef.current += 1
      next = history[indexRef.current]
    } else {
      indexRef.current = -1
      next = draftRef.current
      draftRef.current = ''
    }
    e.preventDefault()
    setAndMoveCursorEnd(next)
    return true
  }

  return { handleKeyDown }
}
