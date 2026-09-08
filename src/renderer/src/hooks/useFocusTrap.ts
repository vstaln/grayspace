import React, { useEffect, useRef } from 'react'

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'




const trapStack: number[] = []
let trapSeq = 0


export function isTopTrap(id: number): boolean {
  return trapStack.length > 0 && trapStack[trapStack.length - 1] === id
}















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
    const id = ++trapSeq
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
