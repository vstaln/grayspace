import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, History, Play, X } from 'lucide-react'
import type { CodeAgent } from './CodeLauncher'
import { useFocusTrap } from '../hooks/useFocusTrap'
import {
  defaultChoice,
  restoreRowTitle,
  startsAgent,
  type RestorableSession
} from '../lib/restorePrompt'

export interface RestorableCodeSession extends RestorableSession<CodeAgent> {
  id: string
  agent: CodeAgent
  title?: string
}

interface Props {
  /** The folder these terminals belong to, for the heading. */
  folderName: string
  sessions: readonly RestorableCodeSession[]
  /** Opens the ticked terminals and drops the rest. */
  onRestore(chosen: Set<string>): void
  /** Keeps none of them. */
  onSkip(): void
}

/**
 * Asked once when a folder's saved board is opened: which of its terminals
 * should actually come back.
 *
 * Everything is ticked, so the fast path is one Enter — the point is not to
 * make restoring harder, it is to make it a decision rather than a dozen CLIs
 * starting behind the user's back.
 */
export default function RestoreSessionsDialog({
  folderName,
  sessions,
  onRestore,
  onSkip
}: Props): React.JSX.Element {
  const [chosen, setChosen] = useState<Set<string>>(() => defaultChoice(sessions))
  const restoreRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  const startable = useMemo(() => sessions.filter(startsAgent), [sessions])
  const count = useMemo(
    () => startable.filter((session) => chosen.has(session.id)).length,
    [chosen, startable]
  )
  const allChosen = count === startable.length && startable.length > 0

  useEffect(() => {
    restoreRef.current?.focus()
  }, [])

  const toggle = useCallback((id: string): void => {
    setChosen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((): void => {
    setChosen((current) => {
      const picked = startable.filter((session) => current.has(session.id)).length
      return picked === startable.length ? new Set() : defaultChoice(startable)
    })
  }, [startable])

  return (
    <div
      ref={dialogRef}
      className="absolute inset-0 z-30 grid place-items-center bg-black/55 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Restore sessions"
      data-testid="code-restore-dialog"
      // No Escape handler on purpose: both answers change the saved board, and
      // one of them closes terminals. A stray Escape must not be one of them.
    >
      <div className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-panel border border-line bg-bg-panel shadow-2xl">
        <header className="flex items-start gap-3 border-b border-line-soft px-4 py-3.5">
          <History size={15} className="mt-0.5 flex-none text-text-faint" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold text-text">
              Restore terminals in {folderName}
            </h2>
            <p className="mt-1 text-[12px] leading-[1.45] text-text-faint">
              These were open when you left. Pick the ones to bring back — the rest are closed,
              and their conversations stay in Resume.
            </p>
          </div>
        </header>

        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {sessions.map((session) => {
            const optional = startsAgent(session)
            const picked = chosen.has(session.id)
            const Icon = session.agent.Icon
            const name = restoreRowTitle(session)
            return (
              <li key={session.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={optional ? picked : true}
                  disabled={!optional}
                  onClick={() => toggle(session.id)}
                  className={`flex w-full items-center gap-2.5 rounded-panel border px-3 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line ${
                    picked || !optional ? 'border-line bg-bg-hover' : 'border-line-soft bg-bg-raise hover:border-line'
                  } ${optional ? '' : 'cursor-default opacity-70'}`}
                >
                  <span
                    className={`grid h-[15px] w-[15px] flex-none place-items-center rounded-panel border ${
                      picked || !optional ? 'border-line bg-text text-bg' : 'border-line-soft text-transparent'
                    }`}
                  >
                    <Check size={10} strokeWidth={3} />
                  </span>
                  <span className="flex-none text-text-dim">
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text">{name}</span>
                    <span
                      className="mt-0.5 block truncate font-mono text-[11px] text-text-faint"
                      title={session.agent.command}
                    >
                      {optional ? session.agent.command : session.agent.label}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-3">
          <span className="mr-auto text-[11px] text-text-faint">
            {count} of {startable.length} selected
          </span>
          {startable.length > 1 && (
            <button
              type="button"
              onClick={toggleAll}
              className="min-h-[36px] rounded-panel px-3 text-[12px] text-text-dim transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
            >
              {allChosen ? 'Clear selection' : `Select all (${startable.length})`}
            </button>
          )}
          <button
            type="button"
            onClick={onSkip}
            className="flex min-h-[36px] items-center gap-1.5 rounded-panel border border-line-soft px-3 text-[12px] text-text-dim transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
          >
            <X size={12} />
            Start fresh
          </button>
          <button
            ref={restoreRef}
            type="button"
            onClick={() => onRestore(new Set(chosen))}
            disabled={count === 0}
            title={count === 0 ? 'Nothing selected — use Start fresh to close them all' : undefined}
            className="flex min-h-[36px] items-center gap-1.5 rounded-panel border border-line bg-bg-hover px-3 text-[12px] font-medium text-text transition-colors duration-150 motion-reduce:transition-none hover:bg-bg-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play size={12} />
            Restore {count}
          </button>
        </footer>
      </div>
    </div>
  )
}
