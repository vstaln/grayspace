import React, { useEffect, useState, useCallback, useRef } from 'react'

export interface ToastItem {
  id: number
  store: string
  message: string
  at: number
  kind?: 'error' | 'info'
}

let nextId = 0

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<number, number>>(new Map())

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
  }, [])

const push = useCallback((store: string, message: string, kind: ToastItem['kind'] = 'error') => {
     // Collapse duplicates: replace same store+kind instead of stacking
     const newItem: ToastItem = { id: ++nextId, store, message, at: Date.now(), kind }
     setToasts((prev) => {
       const idx = prev.findIndex((t) => t.store === store && t.kind === kind)
       if (idx >= 0) {
         const next = prev.slice()
         next[idx] = newItem
         // Clear old timer for replaced item
         const oldTimer = timersRef.current.get(prev[idx].id)
         if (oldTimer !== undefined) {
           window.clearTimeout(oldTimer)
           timersRef.current.delete(prev[idx].id)
         }
         return next
       }
       return [...prev, newItem]
     })
     // Errors persist until dismissed; non-errors auto-dismiss.
     if (kind === 'error') return
     const timer = window.setTimeout(() => {
       timersRef.current.delete(newItem.id)
       setToasts((prev) => prev.filter((t) => t.id !== newItem.id))
     }, 6000)
     timersRef.current.set(newItem.id, timer)
   }, [])

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return { toasts, push, dismiss }
}

export function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): React.JSX.Element | null {
  if (toasts.length === 0) return null
  // Cap queue at 5
  const visible = toasts.slice(-5)
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[70000] flex flex-col gap-2"
      aria-live="polite"
    >
      {visible.map((t) => {
        const isError = t.kind === 'error'
        const borderClass = isError ? 'border-danger/30' : 'border-accent/30'
        const iconClass = isError ? 'text-danger' : 'text-accent'
        const icon = isError ? '⚠' : 'ℹ'
        return (
          <div
            key={t.id}
            role="alert"
            className={`pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-[10px] border ${borderClass} bg-bg-panel px-3 py-2 text-[12px] shadow-lg`}
          >
            <span aria-hidden="true" className={`mt-0.5 ${iconClass}`}>{icon}</span>
            <div className="flex-1">
              <div className="font-medium text-text">Failed to save {t.store}</div>
              <div className="text-text-dim break-words">{t.message.slice(0, 200)}</div>
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(t.id)}
              className="grid min-h-7 min-w-7 place-items-center text-text-dim hover:text-text"
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}

// Global hook that listens to main's persistError broadcast
export function usePersistErrorToasts(push: (store: string, message: string) => void): void {
  useEffect(() => {
    // api.system is exposed via preload if available, otherwise listen on custom event
    const off = (window as unknown as { api?: { system?: { onPersistError?: (cb: (p: { store: string; message: string }) => void) => () => void } } }).api?.system?.onPersistError?.((payload) => {
      push(payload.store, payload.message)
    })
    // Fallback: direct ipcRenderer listener via window.api is the contract; if not yet exposed, no-op
    if (off) return off
    // Also support raw channel for backwards-compat: window.addEventListener via preload bridge
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { store: string; message: string } | undefined
      if (detail) push(detail.store, detail.message)
    }
    window.addEventListener('orcspace:persist-error', handler as EventListener)
    return () => window.removeEventListener('orcspace:persist-error', handler as EventListener)
  }, [push])
}
