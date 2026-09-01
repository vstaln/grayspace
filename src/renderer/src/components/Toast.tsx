import React, { useEffect, useState, useCallback } from 'react'

export interface ToastItem {
  id: number
  store: string
  message: string
  at: number
}

let nextId = 0

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const push = useCallback((store: string, message: string) => {
    const item: ToastItem = { id: ++nextId, store, message, at: Date.now() }
    setToasts((prev) => [...prev, item])
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== item.id))
    }, 6000)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return { toasts, push, dismiss }
}

export function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): React.JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-[10px] border border-red-500/30 bg-bg-panel px-3 py-2 text-[12px] shadow-lg"
        >
          <span className="mt-0.5 text-red-400">⚠</span>
          <div className="flex-1">
            <div className="font-medium text-text">Failed to save {t.store}</div>
            <div className="text-text-dim break-all">{t.message.slice(0, 200)}</div>
          </div>
          <button type="button" onClick={() => onDismiss(t.id)} className="text-text-dim hover:text-text">
            ✕
          </button>
        </div>
      ))}
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
