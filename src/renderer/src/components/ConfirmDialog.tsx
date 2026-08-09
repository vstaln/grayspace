import React, { createContext, useCallback, useContext, useRef, useState } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

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
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, pending !== null)

  const confirm = useCallback<Confirm>(
    (message, options) => new Promise((resolve) => setPending({ message, resolve, ...options })),
    []
  )

  const settle = (value: boolean): void => {
    pending?.resolve(value)
    setPending(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[20000] grid place-items-center bg-black/50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false)
          }}
        >
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title || 'Подтверждение'}
            className="w-[340px] rounded-[10px] border border-line bg-bg-panel p-4 shadow-2xl glass:bg-bg-panel/90 glass:backdrop-blur-2xl"
            onKeyDown={(e) => {
              // Otherwise Escape also bubbles to whatever full-screen panel
              // this dialog is stacked on top of (e.g. Second Brain) and
              // closes that too, when the user only meant to cancel.
              if (e.key === 'Escape') {
                e.stopPropagation()
                settle(false)
              }
            }}
          >
            {pending.title && <h2 className="mb-1.5 text-[13px] font-semibold text-text">{pending.title}</h2>}
            <p className="text-[12.5px] leading-relaxed text-text-dim">{pending.message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                className="rounded-[10px] border border-line-soft px-3 py-1.5 text-[12px] text-text-dim transition-colors hover:border-line hover:text-text"
                onClick={() => settle(false)}
              >
                {pending.cancelLabel || 'Отмена'}
              </button>
              <button
                className={
                  pending.danger
                    ? 'rounded-[10px] border border-danger/30 bg-danger/12 px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/20'
                    : 'rounded-[10px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90'
                }
                onClick={() => settle(true)}
              >
                {pending.confirmLabel || 'Подтвердить'}
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
