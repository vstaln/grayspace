import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, Plus, X } from 'lucide-react'
import TerminalWidget from './TerminalWidget'
import CodeLauncher, { CodeAgent } from './CodeLauncher'
import { queueInitialCommand } from '../lib/pendingTerminalCommands'

interface Session {
  id: string
  agent: CodeAgent
  title?: string
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

const SessionCard = React.memo(function SessionCard({
  session,
  onClose,
  onFocus,
  onRename,
  promotable,
  maximized,
  onToggleMaximize,
  style
}: {
  session: Session
  onClose(): void
  onFocus?(): void
  onRename?(title: string): void
  /** In the featured layout, the small cards can be swapped into the big slot. */
  promotable?: boolean
  maximized: boolean
  onToggleMaximize(): void
  style?: React.CSSProperties
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || session.agent.label

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[8px] border border-line-soft bg-bg-panel ${maximized ? 'absolute inset-0 z-20 rounded-none' : ''}`}
      style={style}
    >
      {/* Promotion lives on the header, never on the terminal below it: a click
          in the body is how the user selects an agent's output to copy, and
          swapping the layout out from under that selection is what made
          copying from a small session impossible (CODE-03). */}
      <div
        className={`flex h-7 flex-none items-center justify-between gap-2 border-b border-line-soft px-2 ${
          promotable && !editing ? 'cursor-pointer transition-colors hover:bg-bg-hover' : ''
        }`}
        onClick={promotable && !editing ? onFocus : undefined}
        onDoubleClick={promotable && !editing ? onFocus : undefined}
        title={promotable && !editing ? 'Click to expand this session' : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px] text-text-dim">
          <span className="flex-none">
            <session.agent.Icon size={12} />
          </span>
          {editing ? (
            <input
              className="h-[20px] min-w-0 flex-1 appearance-none rounded bg-bg-raise px-1.5 text-[11px] text-text outline-none ring-1 ring-line focus:outline-none"
              autoFocus
              defaultValue={displayTitle}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                setEditing(false)
                const val = e.target.value.trim()
                if (val && val !== displayTitle) {
                  onRename?.(val)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditing(false)
                }
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
          ) : (
            <span
              className="truncate cursor-text select-none hover:text-text"
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
            >
              {displayTitle}
            </span>
          )}
        </div>
        <div className="flex flex-none items-center gap-0.5">
          <button
            type="button"
            aria-label={maximized ? 'Restore session' : 'Expand session'}
            title={maximized ? 'Restore session' : 'Expand session'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleMaximize()
            }}
            className="grid h-[18px] w-[18px] place-items-center rounded-[4px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text"
          >
            {maximized ? <Minimize2 size={10} strokeWidth={2.4} /> : <Maximize2 size={10} strokeWidth={2.4} />}
          </button>
          <button
            type="button"
            aria-label="Close session"
            title="Close session"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="grid h-[18px] w-[18px] place-items-center rounded-[4px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text"
          >
            <X size={11} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalWidget id={session.id} onProcessExit={onClose} />
      </div>
    </div>
  )
})

export default function CodeView({ active }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [launcherOpen, setLauncherOpen] = useState(false)
  // Which session is the "big" one in the 3-session featured layout. Falls
  // back to the first session whenever this points at one that's gone.
  const [featuredId, setFeaturedId] = useState<string | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)
  // Auto-open the launcher only on a hidden→visible transition, not on every
  // sessions-length change: otherwise closing the last session while looking
  // at this view would immediately pop the dialog back open over the empty
  // grid the user just cleaned (CODE-02).
  const wasActiveRef = useRef(false)

  useEffect(() => {
    if (active && !wasActiveRef.current && sessions.length === 0) setLauncherOpen(true)
    wasActiveRef.current = active
  }, [active, sessions.length])

  useEffect(() => {
    const offRename = window.api.control.onRenameWidget(({ id, title }) => {
      setSessions((current) =>
        current.map((s) => (s.id === id ? { ...s, title } : s))
      )
    })
    return () => {
      offRename()
    }
  }, [])

  const launch = useCallback((agent: CodeAgent, count: number): void => {
    const created: Session[] = []
    for (let i = 0; i < count; i++) {
      const id = makeSessionId()
      // TerminalWidget reads this once its pty actually attaches (see
      // takeInitialCommand in TerminalWidget.tsx) — queueing it ahead of
      // mount is what lets "launch" both create the terminal and start
      // the agent in it in one gesture.
      queueInitialCommand(id, agent.command)
      created.push({ id, agent, title: agent.label })
    }
    setSessions((current) => [...current, ...created])
  }, [])

  const renameSession = useCallback((id: string, title: string): void => {
    setSessions((current) =>
      current.map((s) => (s.id === id ? { ...s, title } : s))
    )
    window.api.terminal.setTitle?.(id, title).catch(() => {})
  }, [])

  const closeSession = useCallback((id: string): void => {
    // An agent holding the terminal's lock rejects the dispose — expected;
    // the rejection must not surface as an unhandled promise rejection.
    window.api.terminal.dispose(id).catch(() => {})
    setMaximizedId((current) => (current === id ? null : current))
    setSessions((current) => current.filter((s) => s.id !== id))
  }, [])

  // Columns scale with how many sessions are actually open, so a launcher
  // pick of 2 doesn't waste half the pane and 8 doesn't overflow it.
  const columns = sessions.length <= 1 ? 1 : sessions.length <= 4 ? 2 : sessions.length <= 6 ? 3 : 4

  // With exactly 3 sessions a grid wastes half a row — one big terminal on
  // the left with the other two stacked on the right reads better instead.
  const featured =
    sessions.length === 3 ? sessions.find((s) => s.id === featuredId) ?? sessions[0] : null

  /**
   * Grid placement per session. The featured layout is expressed purely as
   * grid coordinates so every card keeps the same DOM parent and sibling order
   * no matter which session is promoted.
   *
   * This matters far more than it looks: rendering the big and small slots as
   * two separate flex containers meant promoting a session moved its node to a
   * different parent, so React unmounted the TerminalWidget and mounted a new
   * one. That tore down xterm, repainted the scrollback from the top and threw
   * away the selection the user was about to copy (CODE-03).
   */
  const placementOf = (sessionId: string): React.CSSProperties => {
    if (!featured) return {}
    if (sessionId === featured.id) return { gridColumn: '1', gridRow: '1 / span 2' }
    const rank = sessions.filter((s) => s.id !== featured.id).findIndex((s) => s.id === sessionId)
    return { gridColumn: '2', gridRow: String(rank + 1) }
  }

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

      {/* One grid for every layout — see placementOf() on why the featured
          arrangement is coordinates rather than a second container. */}
      <div
        className="relative grid min-h-0 flex-1 gap-0 overflow-hidden bg-bg-raise p-0"
        style={
          featured
            ? { gridTemplateColumns: '2fr 1fr', gridTemplateRows: 'repeat(2, minmax(0, 1fr))' }
            : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }
        }
      >
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            style={placementOf(session.id)}
            onClose={() => closeSession(session.id)}
            onFocus={() => setFeaturedId(session.id)}
            onRename={(title) => renameSession(session.id, title)}
            promotable={Boolean(featured) && session.id !== featured?.id}
            maximized={maximizedId === session.id}
            onToggleMaximize={() => setMaximizedId((current) => (current === session.id ? null : session.id))}
          />
        ))}
        {sessions.length === 0 && (
          <div className="grid place-items-center p-6 text-center text-[12px] text-text-faint">
            No code sessions yet — press Launch to start one.
          </div>
        )}
      </div>

      {launcherOpen && <CodeLauncher onClose={() => setLauncherOpen(false)} onLaunch={launch} />}
    </div>
  )
}
