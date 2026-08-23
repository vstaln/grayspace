import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * Modal-panel focus management (P2-206): while `active` is true, Tab and
 * Shift+Tab are confined to `container`, focus moves into the panel when it
 * opens, and is restored to whatever had focus before when it closes.
 */
export function useFocusTrap(
  container: React.RefObject<HTMLElement | null>,
  active: boolean,
  options?: { containOnly?: boolean }
): void {
  const restoreRef = useRef<HTMLElement | null>(null)
  const containOnly = options?.containOnly === true

  useEffect(() => {
    if (!active) return
    const root = container.current
    if (!root) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusable = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      const inside = current instanceof Node && root.contains(current)
      // Side panels (chat) must not yank Tab out of a terminal. Real dialogs
      // still pull focus back when it has escaped the overlay.
      if (containOnly && !inside) return
      if (e.shiftKey && (current === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (current === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    if (!containOnly) focusable()[0]?.focus()
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (restoreRef.current && document.body.contains(restoreRef.current)) {
        restoreRef.current.focus()
      }
    }
  }, [active, container, containOnly])
}
