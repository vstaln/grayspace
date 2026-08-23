import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import TerminalWidget from './TerminalWidget'
import CodeLauncher, { CodeAgent } from './CodeLauncher'
import { queueInitialCommand } from '../lib/pendingTerminalCommands'

interface Session {
  id: string
  agent: CodeAgent
}

let sessionCounter = 0
function makeSessionId(): string {
  sessionCounter += 1
  return `code-${Date.now()}-${sessionCounter}`
}

interface Props {
  /** The view keeps its sessions alive while hidden, same as BrowserPane —
   *  switching to Canvas and back must not kill a running agent. */
  active: boolean
}

function SessionCard({
  session,
  onClose,
  onFocus,
  focusable
}: {
  session: Session
  onClose(): void
  onFocus?(): void
  /** Only the featured-layout's small cards are clickable to swap in. */
  focusable?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[8px] border border-line-soft bg-bg-panel ${
        focusable ? 'cursor-pointer transition-colors hover:border-line' : ''
      }`}
      onClick={focusable ? onFocus : undefined}
    >
      <div className="flex h-7 flex-none items-center justify-between gap-2 border-b border-line-soft px-2">
        <span className="flex items-center gap-1.5 truncate text-[11px] text-text-dim">
          <session.agent.Icon size={12} />
          {session.agent.label}
        </span>
        <button
          type="button"
          aria-label="Close session"
          title="Close session"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="grid h-[18px] w-[18px] flex-none place-items-center rounded-[4px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text"
        >
          <X size={11} strokeWidth={2.4} />
        </button>
      </div>
      <div className={`min-h-0 flex-1 ${focusable ? 'pointer-events-none' : ''}`}>
        <TerminalWidget id={session.id} onProcessExit={onClose} />
      </div>
    </div>
  )
}

export default function CodeView({ active }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [launcherOpen, setLauncherOpen] = useState(false)
  // Which session is the "big" one in the 3-session featured layout. Falls
  // back to the first session whenever this points at one that's gone.
  const [featuredId, setFeaturedId] = useState<string | null>(null)
  // Auto-open the launcher only on a hidden→visible transition, not on every
  // sessions-length change: otherwise closing the last session while looking
  // at this view would immediately pop the dialog back open over the empty
  // grid the user just cleaned (CODE-02).
  const wasActiveRef = useRef(false)

  useEffect(() => {
    if (active && !wasActiveRef.current && sessions.length === 0) setLauncherOpen(true)
    wasActiveRef.current = active
  }, [active, sessions.length])

  const launch = useCallback((agent: CodeAgent, count: number): void => {
    const created: Session[] = []
    for (let i = 0; i < count; i++) {
      const id = makeSessionId()
      // TerminalWidget reads this once its pty actually attaches (see
      // takeInitialCommand in TerminalWidget.tsx) — queueing it ahead of
      // mount is what lets "launch" both create the terminal and start
      // the agent in it in one gesture.
      queueInitialCommand(id, agent.command)
      created.push({ id, agent })
    }
    setSessions((current) => [...current, ...created])
  }, [])

  const closeSession = useCallback((id: string): void => {
    // An agent holding the terminal's lock rejects the dispose — expected;
    // the rejection must not surface as an unhandled promise rejection.
    window.api.terminal.dispose(id).catch(() => {})
    setSessions((current) => current.filter((s) => s.id !== id))
  }, [])

  // Columns scale with how many sessions are actually open, so a launcher
  // pick of 2 doesn't waste half the pane and 8 doesn't overflow it.
  const columns = sessions.length <= 1 ? 1 : sessions.length <= 4 ? 2 : sessions.length <= 6 ? 3 : 4

  // With exactly 3 sessions a grid wastes half a row — one big terminal on
  // the left with the other two stacked on the right reads better instead.
  const featured =
    sessions.length === 3 ? sessions.find((s) => s.id === featuredId) ?? sessions[0] : null
  const others = featured ? sessions.filter((s) => s.id !== featured.id) : []

  return (
    <div
      // Above every canvas layer, below the title bar's z-[50000] — mirrors
      // BrowserPane's stacking so the view switcher stays reachable. Left
      // edge starts past the rail so the sidebar keeps its own column
      // instead of floating on top of this view's content.
      className={`absolute inset-y-0 right-0 left-rail z-[40000] flex flex-col pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      <div className="flex h-9 flex-none items-center justify-between gap-2 border-b border-line-soft bg-bg-panel px-2.5">
        <p className="text-[11px] text-text-faint">
          {sessions.length === 0
            ? 'No code sessions running'
            : `${sessions.length} session${sessions.length > 1 ? 's' : ''}`}
        </p>
        <button
          type="button"
          onClick={() => setLauncherOpen(true)}
          className="flex items-center gap-1.5 rounded-[8px] border border-line-soft bg-bg-hover/30 px-2.5 py-1 text-[12px] text-text transition-colors hover:bg-bg-hover"
        >
          <Plus size={13} strokeWidth={2.2} /> Launch
        </button>
      </div>

      {featured ? (
        <div className="flex flex-1 gap-0 overflow-auto bg-bg-raise p-0">
          <div className="flex min-h-0 min-w-0 flex-[2] flex-col">
            <SessionCard session={featured} onClose={() => closeSession(featured.id)} />
          </div>
          <div className="flex min-h-0 w-0 flex-1 flex-col gap-0">
            {others.map((session) => (
              <div key={session.id} className="min-h-0 flex-1">
                <SessionCard
                  session={session}
                  onClose={() => closeSession(session.id)}
                  onFocus={() => setFeaturedId(session.id)}
                  focusable
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="grid flex-1 gap-0 overflow-auto bg-bg-raise p-0"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} onClose={() => closeSession(session.id)} />
          ))}
        </div>
      )}

      {launcherOpen && <CodeLauncher onClose={() => setLauncherOpen(false)} onLaunch={launch} />}
    </div>
  )
}
