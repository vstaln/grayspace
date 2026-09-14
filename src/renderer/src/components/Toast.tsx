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

     const newItem: ToastItem = { id: ++nextId, store, message, at: Date.now(), kind }
     setToasts((prev) => {
       const idx = prev.findIndex((t) => t.store === store && t.kind === kind)
       if (idx >= 0) {
         const next = prev.slice()
         next[idx] = newItem

         const oldTimer = timersRef.current.get(prev[idx].id)
         if (oldTimer !== undefined) {
           window.clearTimeout(oldTimer)
           timersRef.current.delete(prev[idx].id)
         }
         return next
       }
       return [...prev, newItem]
     })

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

export function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): React.JSX.Element {
  // The live region has to already be in the document when content is inserted
  // into it, otherwise screen readers miss the very first toast. Returning null
  // while empty re-created the region with the toast already inside it, which
  // announces nothing. Keep the region mounted and let it be empty instead.
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
            // No role="alert" here: the wrapper is already a live region, and
            // nesting one inside another made every toast announce twice.
            className={`pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-panel border ${borderClass} bg-bg-panel px-3 py-2 text-[12px] shadow-lg`}
          >
            <span aria-hidden="true" className={`mt-0.5 ${iconClass}`}>{icon}</span>
            <div className="flex-1">
              {/* `push` accepts kind: 'info', and those are not save failures. */}
              <div className="font-medium text-text">{isError ? `Failed to save ${t.store}` : t.store}</div>
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


export function usePersistErrorToasts(push: (store: string, message: string) => void): void {
  useEffect(() => {

    const off = (window as unknown as { api?: { system?: { onPersistError?: (cb: (p: { store: string; message: string }) => void) => () => void } } }).api?.system?.onPersistError?.((payload) => {
      push(payload.store, payload.message)
    })

    if (off) return off

    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { store: string; message: string } | undefined
      if (detail) push(detail.store, detail.message)
    }
    window.addEventListener('orcspace:persist-error', handler as EventListener)
    return () => window.removeEventListener('orcspace:persist-error', handler as EventListener)
  }, [push])
}

export function useTerminalBackendErrorToasts(push: (store: string, message: string) => void): void {
  useEffect(() => {
    const off = window.api?.terminal?.onBackendError?.((message) => {
      push('terminal-engine', message)
    })
    return off
  }, [push])
}
