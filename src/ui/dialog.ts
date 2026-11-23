import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal dialog behaviour: focus `initial` on open, Escape closes, Tab stays
 * inside `panel`, and focus goes back where it was on close.
 */
export function useModal(panel: RefObject<HTMLElement | null>, initial: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    initial.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex !== -1)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      before?.focus?.()
    }
  }, [onClose, panel, initial])
}
