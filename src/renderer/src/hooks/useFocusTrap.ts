import React, { useEffect, useRef, useState } from 'react'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
/**
 * Stack of active trap ids — only the topmost trap handles Tab so nested
 * dialogs (confirm over settings, rename over folders) don't fight.
 */
const trapStack: number[] = []
let trapSeq = 0

/** Number of currently active focus traps (for debugging / frontmost checks). */
export function activeTrapCount(): number {
  return trapStack.length
}

/** True when the given trap id is the frontmost trap. */
export function isTopTrap(id: number): boolean {
  return trapStack.length > 0 && trapStack[trapStack.length - 1] === id
}

/** ID of the frontmost active trap, or null if none. */
export function topTrapId(): number | null {
  return trapStack.length > 0 ? trapStack[trapStack.length - 1] : null
}

/** Get all active trap IDs in order (bottom to top). */
export function getTrapStack(): number[] {
  return [...trapStack]
}

/** Generate the next trap ID. */
export function nextTrapId(): number {
  return ++trapSeq
}

/**
 * Modal-panel focus management (P2-206): while `active` is true, Tab and
 * Shift+Tab are confined to `container`, focus moves into the panel when it
 * opens, and is restored to whatever had focus before when it closes.
 *
 * Stack-safe: nested traps register in `trapStack` and only the topmost one
 * handles Tab, so a confirm opened over settings doesn't fight the parent.
 * Initial focus is deferred via requestAnimationFrame so the portal layout
 * has landed; when no focusable child exists the root itself is focused
 * (it gets a tabIndex=-1 fallback for that purpose).
 *
 * Returns the trap id so callers can check frontmost status (e.g. for
 * Escape-key routing in nested dialogs).
 */
export function useFocusTrap(
  container: React.RefObject<HTMLElement | null>,
  active: boolean,
  options?: { containOnly?: boolean }
): number | null {
  const restoreRef = useRef<HTMLElement | null>(null)
  const containOnly = options?.containOnly === true
  const [trapId, setTrapId] = React.useState<number | null>(null)

  useEffect(() => {
    if (!active) return
    const root = container.current
    if (!root) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const id = nextTrapId()
    setTrapId(id)
    trapStack.push(id)

    const isVisible = (el: HTMLElement): boolean => {
      if (el.getClientRects().length === 0) return false
      const style = getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
    }
    const focusable = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible)

    const ensureRootFocusable = (): void => {
      if (root.getAttribute('tabindex') === null && (root.tabIndex < 0 || Number.isNaN(root.tabIndex))) {
        root.setAttribute('tabindex', '-1')
      }
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      // Only the frontmost trap owns Tab.
      if (trapStack[trapStack.length - 1] !== id) return
      const items = focusable()
      if (items.length === 0) {
        e.preventDefault()
        ensureRootFocusable()
        root.focus?.()
        return
      }
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
    // Defer so portaled dialogs have painted and real sizes before focus lands.
    const raf = requestAnimationFrame(() => {
      if (!containOnly) {
        const items = focusable()
        if (items.length > 0) {
          items[0]?.focus()
        } else {
          ensureRootFocusable()
          root.focus?.()
        }
      }
    })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown, true)
      const idx = trapStack.indexOf(id)
      if (idx >= 0) trapStack.splice(idx, 1)
      if (restoreRef.current && document.body.contains(restoreRef.current)) {
        restoreRef.current.focus()
      }
    }
  }, [active, container, containOnly])
  
  return trapId
}
