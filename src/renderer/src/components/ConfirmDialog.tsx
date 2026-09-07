import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useFocusTrap, isTopTrap, nextTrapId } from '../hooks/useFocusTrap'

interface ConfirmOptions {
  title?: string
  /** Renders the confirm button in the danger palette — for destructive actions. */
  danger?: boolean
  confirmLabel?: string
  cancelLabel?: string
}

interface PendingConfirm extends ConfirmOptions {
  message: string
  resolve(value: boolean): void
  hashCode?: number
}

type Confirm = (message: string, options?: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Confirm>(async () => false)

/**
 * In-app replacement for `window.confirm`. Electron's native dialog looks like
 * an OS/browser chrome window dropped on top of the app — this renders the same
 * yes/no prompt as one more panel in the app's own style instead.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const pendingRef = useRef<PendingConfirm | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [pendingQueue, setPendingQueue] = useState<PendingConfirm[]>([])
  const trapId = useFocusTrap(dialogRef, pending !== null)

  const confirm = useCallback<Confirm>(
    (message, options) => {
      // Queue new confirms when one is already pending
      if (pendingRef.current) {
        return new Promise<boolean>((resolve) => {
          setPendingQueue((prev) => [...prev, { message, resolve, ...options } as PendingConfirm])
        })
      }
      // Show immediately
      return new Promise<boolean>((resolve) => {
        pendingRef.current = { message, resolve, ...options } as PendingConfirm
        setPending({ message, resolve, ...options } as PendingConfirm)
      })
    },
    []
  )

  // Window-level Escape handler with frontmost check
  useEffect(() => {
    if (!pending) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && trapId !== null && isTopTrap(trapId)) {
        e.stopPropagation()
        settle(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [pending, trapId])

  const settle = (value: boolean): void => {
    pending?.resolve(value)
    pendingRef.current = null
    
    // If there are queued confirms, show the next one
    if (pendingQueue.length > 0) {
      const next = pendingQueue[0]
      setPendingQueue((prev) => prev.slice(1))
      setPending(next)
      pendingRef.current = next
    } else {
      setPending(null)
    }
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[70000] grid place-items-center bg-black/50 p-3 backdrop-blur-[2px]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false)
          }}
        >
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title || 'Confirmation'}
            aria-describedby="confirm-msg"
            className="max-h-[calc(100vh-24px)] w-full max-w-[340px] overflow-auto rounded-[10px] border border-line bg-bg-panel p-4 shadow-2xl"
            tabIndex={-1}  // Add tabIndex=-1 for focus trapping
            onKeyDown={(e) => {
              // Only handle Escape if this is the frontmost trap
              if (e.key === 'Escape' && isTopTrap(pendingRef.current?.hashCode ?? 0)) {
                e.stopPropagation()
                settle(false)
              }
            }}
          >
            {pending.title && (
              <h2 className="mb-1.5 truncate text-[13px] font-semibold text-text">{pending.title}</h2>
            )}
            <p id="confirm-msg" className="max-h-[40vh] overflow-auto text-[12.5px] leading-relaxed break-words text-text-dim">
              {pending.message}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                data-testid="confirm-cancel"
                className="rounded-[10px] border border-line-soft px-3 py-1.5 text-[12px] text-text-dim transition-colors duration-150 hover:border-line hover:text-text"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel || 'Cancel'}
              </button>
              <button
                data-testid="confirm-accept"
                className={
                  pending.danger
                    ? 'rounded-[10px] border border-danger/30 bg-danger/12 px-3 py-1.5 text-[12px] text-danger transition-colors duration-150 hover:bg-danger/20'
                    : 'rounded-[10px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition-opacity duration-150 hover:opacity-90'
                }
                onClick={() => settle(true)}
              >
                {pending.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

/** `if (await confirm('Delete it?')) …` — same shape as `window.confirm`, minus the OS chrome. */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext)
}
