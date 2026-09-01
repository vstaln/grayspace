import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import TerminalWidget from './TerminalWidget'
import CodeLauncher, { CODE_AGENTS, CodeAgent } from './CodeLauncher'
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

function agentForPersisted(agentId: string, label: string, command: string): CodeAgent {
  const found = CODE_AGENTS.find((a) => a.id === agentId)
  if (found && found.command === command) return found
  if (found && agentId !== 'custom') return found
  // Fallback for custom or unknown agents — preserve stored label/command
  return { id: agentId || 'custom', label: label || command || 'Other CLI', command, Icon: TerminalIcon }
}

function extractCounter(id: string): number | null {
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
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
        onClick={(e) => {
          if (!editing) {
            onFocus?.()
            const termEl = e.currentTarget.parentElement?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
            termEl?.focus()
          }
        }}
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

  // ---- persistence (code sessions survive restarts per workspace) ----
  const hydratedRef = useRef(false)
  const skipNextSaveRef = useRef(false)
  const hydrationRunRef = useRef(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceDirRef = useRef<string | null>(null)
  const codeChangeSeqRef = useRef(0)
  const dirtyRef = useRef(false)

  const hydrate = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    dirtyRef.current = false
    const run = ++hydrationRunRef.current
    const changesAtStart = codeChangeSeqRef.current
    hydratedRef.current = false
    skipNextSaveRef.current = true
    void window.api.code
      .load()
      .then((snapshot) => {
        if (run !== hydrationRunRef.current) return
        if (codeChangeSeqRef.current !== changesAtStart) {
          hydratedRef.current = true
          return
        }
        const restored: Session[] = (snapshot.sessions ?? []).map((s) => ({
          id: s.id,
          agent: agentForPersisted(s.agentId, s.label, s.command),
          title: s.title ?? s.label
        }))
        // Keep counter ahead of any restored id so new sessions never collide
        let maxCounter = 0
        for (const s of restored) {
          const c = extractCounter(s.id)
          if (c !== null && c > maxCounter) maxCounter = c
        }
        if (maxCounter > sessionCounter) sessionCounter = maxCounter
        setSessions(restored)
        setFeaturedId(snapshot.featuredId ?? null)
        setMaximizedId(snapshot.maximizedId ?? null)
        hydratedRef.current = true
      })
      .catch(() => {
        if (run !== hydrationRunRef.current) return
        // Keep hydrated false so next save is skipped; background retry via workspace change or manual?
        hydratedRef.current = true
      })
  }, [])

  useEffect(() => {
    void window.api.workspace
      .getDir()
      .then((dir) => {
        workspaceDirRef.current = dir
      })
      .catch(() => {})
      .finally(() => hydrate())
    const unbindDir = window.api.workspace.onDirChange((dir) => {
      if (workspaceDirRef.current === dir) return
      workspaceDirRef.current = dir
      hydrate()
    })
    return () => {
      unbindDir()
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [hydrate])

  // Save on sessions/featured/maximized changes (debounced)
  useEffect(() => {
    if (!hydratedRef.current) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    dirtyRef.current = true
    const dirAtSchedule = workspaceDirRef.current
    const timer = setTimeout(() => {
      saveTimerRef.current = null
      if (workspaceDirRef.current !== dirAtSchedule) return
      const payload = {
        sessions: sessions.map((s) => ({
          id: s.id,
          agentId: s.agent.id,
          label: s.agent.label,
          command: s.agent.command,
          title: s.title ?? s.agent.label
        })),
        featuredId,
        maximizedId,
        workspaceDir: dirAtSchedule ?? null
      }
      dirtyRef.current = false
      void window.api.code.save(payload).catch(() => {})
    }, 800)
    saveTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      if (saveTimerRef.current === timer) saveTimerRef.current = null
    }
  }, [sessions, featuredId, maximizedId])

  // External updates (workspace switch from main, or another renderer)
  useEffect(() => {
    return window.api.code.onChange((snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.sessions)) return
      codeChangeSeqRef.current += 1
      if (!hydratedRef.current) return
      skipNextSaveRef.current = true
      // If we have unsaved local edits, don't overwrite them with stale snapshot
      if (dirtyRef.current) return
      const restored: Session[] = (snapshot.sessions ?? []).map((s) => ({
        id: s.id,
        agent: agentForPersisted(s.agentId, s.label, s.command),
        title: s.title ?? s.label
      }))
      let maxCounter = 0
      for (const s of restored) {
        const c = extractCounter(s.id)
        if (c !== null && c > maxCounter) maxCounter = c
      }
      if (maxCounter > sessionCounter) sessionCounter = maxCounter
      setSessions(restored)
      setFeaturedId(snapshot.featuredId ?? null)
      setMaximizedId(snapshot.maximizedId ?? null)
    })
  }, [])

  useEffect(() => {
    if (!hydratedRef.current) return
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

  const handlerCacheRef = useRef<Map<string, {
    onClose: () => void
    onFocus: () => void
    onRename: (title: string) => void
    onToggleMaximize: () => void
  }>>(new Map())

  const getSessionHandlers = (id: string) => {
    let handlers = handlerCacheRef.current.get(id)
    if (!handlers) {
      handlers = {
        onClose: () => closeSession(id),
        onFocus: () => setFeaturedId(id),
        onRename: (title: string) => renameSession(id, title),
        onToggleMaximize: () => setMaximizedId((current) => (current === id ? null : id))
      }
      handlerCacheRef.current.set(id, handlers)
    }
    return handlers
  }

  useEffect(() => {
    const cache = handlerCacheRef.current
    if (cache.size === 0) return
    const live = new Set(sessions.map((s) => s.id))
    for (const id of Array.from(cache.keys())) {
      if (!live.has(id)) cache.delete(id)
    }
  }, [sessions])

  // Columns scale with how many sessions are actually open, so a launcher
  // pick of 2 doesn't waste half the pane and 8 doesn't overflow it.
  const columns = sessions.length <= 1 ? 1 : sessions.length <= 4 ? 2 : sessions.length <= 6 ? 3 : 4

  // With exactly 3 sessions a grid used to promote one terminal to a big
  // left slot (featured). That caused closing 1 of 4 → 3 to auto-promote
  // sessions[0] and make another card "fly" to the top-right. Disable the
  // automatic fallback — featured layout now only applies when the user has
  // explicitly clicked a small card to promote it.
  const featured =
    sessions.length === 3 ? sessions.find((s) => s.id === featuredId) ?? null : null

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
        {sessions.map((session) => {
          const handlers = getSessionHandlers(session.id)
          return (
            <SessionCard
              key={session.id}
              session={session}
              style={placementOf(session.id)}
              onClose={handlers.onClose}
              onFocus={handlers.onFocus}
              onRename={handlers.onRename}
              promotable={Boolean(featured) && session.id !== featured?.id}
              maximized={maximizedId === session.id}
              onToggleMaximize={handlers.onToggleMaximize}
            />
          )
        })}
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
