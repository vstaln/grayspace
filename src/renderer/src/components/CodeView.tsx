import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import TerminalWidget, { forgetTerminalViewport } from './TerminalWidget'
import BrowserWidget from './BrowserWidget'
import CodeLauncher, { CODE_AGENTS, CodeAgent } from './CodeLauncher'
import { queueInitialCommand } from '../lib/pendingTerminalCommands'
import { forgetAgentSelection } from './WidgetFrame'

interface Session {
  id: string
  agent: CodeAgent
  title?: string
  status: 'active' | 'finished'
}

let sessionCounter = 0
const MAX_CODE_SESSIONS = 32
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

function isBrowserSession(session: Pick<Session, 'agent'>): boolean {
  return session.agent.id === 'browser'
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
  onProcessExit,
  onFocus,
  onRename,
  onSwap,
  onDragStart,
  onDragOver,
  onDragEnd,
  promotable,
  maximized,
  onToggleMaximize,
  dragging,
  dropTarget,
  style
}: {
  session: Session
  onClose(): void
  onProcessExit(): void
  onFocus?(): void
  onRename?(title: string): void
  onSwap(sourceId: string, targetId: string): void
  onDragStart(id: string): void
  onDragOver(id: string): void
  onDragEnd(): void
  /** In the featured layout, the small cards can be swapped into the big slot. */
  promotable?: boolean
  maximized: boolean
  onToggleMaximize(): void
  dragging?: boolean
  dropTarget?: boolean
  style?: React.CSSProperties
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || session.agent.label

  return (
    <div
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[8px] border border-line-soft transition-[opacity,box-shadow] ${
        isBrowserSession(session) ? 'bg-bg-panel' : 'code-terminal-shell'
      } ${
        maximized ? 'absolute inset-0 z-20 rounded-none' : ''
      } ${dragging ? 'opacity-45' : ''} ${dropTarget ? 'ring-2 ring-accent ring-inset' : ''}`}
      style={style}
    >
      {/* Promotion lives on the header, never on the terminal below it: a click
          in the body is how the user selects an agent's output to copy, and
          swapping the layout out from under that selection is what made
          copying from a small session impossible (CODE-03). */}
      <div
        draggable={!editing && !maximized}
        aria-grabbed={dragging || undefined}
        className={`code-session-header flex h-7 flex-none items-center justify-between gap-2 border-b border-line-soft px-2 ${
          !editing && !maximized ? 'cursor-grab transition-colors hover:bg-bg-hover active:cursor-grabbing' : ''
        }`}
        onDragStart={(e) => {
          if (editing || maximized || (e.target as HTMLElement).closest('button, input')) {
            e.preventDefault()
            return
          }
          e.stopPropagation()
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/session-id', session.id)
          e.dataTransfer.setData('text/plain', session.id)
          onDragStart(session.id)
        }}
        onDragEnd={(e) => {
          e.stopPropagation()
          onDragEnd()
        }}
        onDragOver={(e) => {
          if (editing || maximized) return
          if (!Array.from(e.dataTransfer.types).some((type) => type === 'text/session-id' || type === 'text/plain')) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
          onDragOver(session.id)
        }}
        onDrop={(e) => {
          if (editing || maximized) return
          e.preventDefault()
          e.stopPropagation()
          const sourceId = e.dataTransfer.getData('text/session-id') || e.dataTransfer.getData('text/plain')
          if (sourceId && sourceId !== session.id) onSwap(sourceId, session.id)
          onDragEnd()
        }}
        onClick={(e) => {
          if (!editing) {
            onFocus?.()
            const termEl = e.currentTarget.parentElement?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
            termEl?.focus()
          }
        }}
        onDoubleClick={promotable && !editing ? onFocus : undefined}
        title={!editing && !maximized ? (promotable ? 'Drag to swap · double-click to expand' : 'Drag to swap session') : undefined}
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
              className="truncate cursor-default select-none hover:text-text"
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
          {session.status === 'finished' && (
            <span
              className="flex flex-none items-center gap-1 rounded-full border border-line-soft bg-bg-raise px-1.5 py-px text-[10px] text-text-faint"
              title="Process exited"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
              Finished
            </span>
          )}
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
        {isBrowserSession(session) ? <BrowserWidget /> : <TerminalWidget id={session.id} surface="code" onProcessExit={onProcessExit} />}
      </div>
    </div>
  )
})

export default function CodeView({ active }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const sessionsRef = useRef<Session[]>(sessions)
  sessionsRef.current = sessions
  const [launcherOpen, setLauncherOpen] = useState(false)
  // Which session is the "big" one in the 3-session featured layout. Falls
  // back to the first session whenever this points at one that's gone.
  const [featuredId, setFeaturedId] = useState<string | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)
  const featuredIdRef = useRef<string | null>(featuredId)
  const maximizedIdRef = useRef<string | null>(maximizedId)
  featuredIdRef.current = featuredId
  maximizedIdRef.current = maximizedId
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Auto-open the launcher only on a hidden→visible transition, not on every
  // sessions-length change: otherwise closing the last session while looking
  // at this view would immediately pop the dialog back open over the empty
  // grid the user just cleaned (CODE-02).
  const wasActiveRef = useRef(false)

  useEffect(() => {
    const openLauncher = (): void => setLauncherOpen(true)
    window.addEventListener('orcspace:open-code-launcher', openLauncher)
    return () => window.removeEventListener('orcspace:open-code-launcher', openLauncher)
  }, [])

  // ---- persistence (code sessions survive restarts per workspace) ----
  const hydratedRef = useRef(false)
  const skipNextSaveRef = useRef(false)
  const hydrationRunRef = useRef(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const codeWorkspaceIdRef = useRef('code-default')
  const codeChangeSeqRef = useRef(0)
  const dirtyRef = useRef(false)

  const markLocalChange = useCallback(() => {
    codeChangeSeqRef.current += 1
    dirtyRef.current = true
  }, [])

  useEffect(() => {
    const flushBeforeSwitch = (): void => {
      if (!hydratedRef.current) return
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      dirtyRef.current = false
      void window.api.code.save({
        sessions: sessionsRef.current.map((session) => ({
          id: session.id,
          agentId: session.agent.id,
          label: session.agent.label,
          command: session.agent.command,
          title: session.title ?? session.agent.label,
          status: session.status
        })),
        featuredId: featuredIdRef.current,
        maximizedId: maximizedIdRef.current,
        codeWorkspaceId: codeWorkspaceIdRef.current
      }).catch(() => {})
    }
    window.addEventListener('orcspace:before-code-workspace-switch', flushBeforeSwitch)
    return () => window.removeEventListener('orcspace:before-code-workspace-switch', flushBeforeSwitch)
  }, [])

  const hydrate = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    dirtyRef.current = false
    const run = ++hydrationRunRef.current
    const changesAtStart = codeChangeSeqRef.current
    hydratedRef.current = false
    // Hydration itself is not an external update. Keeping this flag armed
    // here loses the first session when the restored snapshot is empty (the
    // `setSessions([])` below is a no-op, so no save effect consumes it).
    // External broadcasts arm the flag separately below.
    skipNextSaveRef.current = false
    // Do not show or accidentally save sessions belonging to the previous
    // workspace while this workspace is being loaded.
    setSessions([])
    setFeaturedId(null)
    setMaximizedId(null)
    void window.api.code
      .load()
      .then((snapshot) => {
        if (run !== hydrationRunRef.current) return
        if (codeChangeSeqRef.current !== changesAtStart) {
          hydratedRef.current = true
          // A user action happened while load was in flight. Keep the live
          // state and let the normal debounced save persist it.
          skipNextSaveRef.current = false
          setSessions((current) => [...current])
          return
        }
        const restored: Session[] = (snapshot.sessions ?? []).map((s) => ({
          id: s.id,
          agent: agentForPersisted(s.agentId, s.label, s.command),
          title: s.title ?? s.label,
          status: s.status === 'finished' ? 'finished' : 'active'
        }))
        // Re-launch persisted agents when their old PTY is gone. TerminalWidget
        // consumes this only for a fresh process and ignores it on reconnect.
        for (const session of restored) {
          if (session.status === 'active' && !isBrowserSession(session)) queueInitialCommand(session.id, session.agent.command)
        }
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
    let mounted = true
    void window.api.workspace
      .codeWorkspaces()
      .then((state) => {
        if (!mounted) return
        codeWorkspaceIdRef.current = state.activeId
        hydrate()
      })
      .catch(() => { if (mounted) hydrate() })
    const unbindWorkspace = window.api.workspace.onCodeWorkspaceChange((state) => {
      codeWorkspaceIdRef.current = state.activeId
      hydrate()
    })
    return () => {
      mounted = false
      hydrationRunRef.current += 1
      unbindWorkspace()
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
    const workspaceIdAtSchedule = codeWorkspaceIdRef.current
    const timer = setTimeout(() => {
      saveTimerRef.current = null
      if (codeWorkspaceIdRef.current !== workspaceIdAtSchedule) return
      const payload = {
        sessions: sessions.map((s) => ({
          id: s.id,
          agentId: s.agent.id,
          label: s.agent.label,
          command: s.agent.command,
          title: s.title ?? s.agent.label,
          status: s.status
        })),
        featuredId,
        maximizedId,
        codeWorkspaceId: workspaceIdAtSchedule
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
      // A broadcast received while the initial/workspace hydrate is in flight
      // is expected, not a user edit. Counting it here makes hydrate discard
      // its authoritative load result and leave the view empty.
      if (!hydratedRef.current) return
      codeChangeSeqRef.current += 1
      // If we have unsaved local edits, don't overwrite them with stale snapshot
      if (dirtyRef.current) return
      skipNextSaveRef.current = true
      const restored: Session[] = (snapshot.sessions ?? []).map((s) => ({
        id: s.id,
        agent: agentForPersisted(s.agentId, s.label, s.command),
        title: s.title ?? s.label,
        status: s.status === 'finished' ? 'finished' : 'active'
      }))
      for (const session of restored) {
        if (session.status === 'active' && !isBrowserSession(session)) queueInitialCommand(session.id, session.agent.command)
      }
      let maxCounter = 0
      for (const s of restored) {
        const c = extractCounter(s.id)
        if (c !== null && c > maxCounter) maxCounter = c
      }
      if (maxCounter > sessionCounter) sessionCounter = maxCounter
      setSessions(restored)
      setFeaturedId(snapshot.featuredId ?? null)
      setMaximizedId(snapshot.maximizedId ?? null)
      // If the incoming snapshot is identical to local state, React may bail
      // out of all three setters and the save effect will never run to consume
      // the skip flag. Clear it on the next task so the next user edit is not
      // silently skipped.
      setTimeout(() => {
        if (skipNextSaveRef.current) skipNextSaveRef.current = false
      }, 0)
    })
  }, [])

  useEffect(() => {
    if (!hydratedRef.current) return
    if (active && !wasActiveRef.current && sessions.length === 0) setLauncherOpen(true)
    wasActiveRef.current = active
  }, [active, sessions.length])

  // The shared Workspace sidebar mirrors this list even while Code is hidden.
  // The event is renderer-local and complements the durable CodeStore snapshot.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('orcspace:code-sessions', {
      detail: sessions.map((session) => ({
        id: session.id,
        title: session.title || session.agent.label,
        status: session.status
      }))
    }))
  }, [sessions])

  useEffect(() => {
    const focusSession = (event: Event): void => {
      const id = (event as CustomEvent<unknown>).detail
      if (typeof id !== 'string' || !sessionsRef.current.some((session) => session.id === id)) return
      markLocalChange()
      setFeaturedId(id)
    }
    window.addEventListener('orcspace:focus-code-session', focusSession)
    return () => window.removeEventListener('orcspace:focus-code-session', focusSession)
  }, [markLocalChange])

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
    markLocalChange()
    // Build ids and queue initial commands OUTSIDE the updater: updaters must
    // stay pure (they may re-run), and a re-run would mint discarded ids with
    // orphaned queued commands. The updater below only clamps to room left.
    const amount = Math.min(count, Math.max(0, MAX_CODE_SESSIONS - sessionsRef.current.length))
    const created: Session[] = []
    for (let i = 0; i < amount; i++) {
      const id = makeSessionId()
      // TerminalWidget reads this once its pty actually attaches (see
      // takeInitialCommand in TerminalWidget.tsx) — queueing it ahead of
      // mount is what lets "launch" both create the terminal and start
      // the agent in it in one gesture.
      if (agent.id !== 'browser') queueInitialCommand(id, agent.command)
      created.push({ id, agent, title: agent.label, status: 'active' })
    }
    if (created.length === 0) return
    setSessions((current) => {
      const room = Math.max(0, MAX_CODE_SESSIONS - current.length)
      return [...current, ...created.slice(0, room)]
    })
  }, [markLocalChange])

  const renameSession = useCallback((id: string, title: string): void => {
    markLocalChange()
    setSessions((current) =>
      current.map((s) => (s.id === id ? { ...s, title } : s))
    )
    window.api.terminal.setTitle?.(id, title).catch(() => {})
  }, [markLocalChange])

  const closeSession = useCallback((id: string): void => {
    const session = sessionsRef.current.find((item) => item.id === id)
    if (session && !isBrowserSession(session)) {
      window.api.terminal.dispose(id).then((res: unknown) => {
        if (res && typeof res === 'object' && 'error' in (res as Record<string, unknown>)) console.warn('terminal dispose rejected', (res as { error: string }).error)
      }).catch((err) => console.warn('terminal dispose failed', err))
    }
    markLocalChange()
    handlerCacheRef.current.delete(id)
    forgetTerminalViewport(id)
    forgetAgentSelection(id)
    setFeaturedId((current) => (current === id ? null : current))
    setMaximizedId((current) => (current === id ? null : current))
    setSessions((current) => current.filter((s) => s.id !== id))
  }, [markLocalChange])

  const finishSession = useCallback((id: string): void => {
    markLocalChange()
    setSessions((current) => current.map((session) =>
      session.id === id ? { ...session, status: 'finished' } : session
    ))
  }, [markLocalChange])

  const swapSessions = useCallback((sourceId: string, targetId: string): void => {
    if (!sourceId || !targetId || sourceId === targetId) return
    markLocalChange()
    setSessions((current) => {
      const sourceIndex = current.findIndex((session) => session.id === sourceId)
      const targetIndex = current.findIndex((session) => session.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...current]
      ;[next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]]
      return next
    })
    // The three-session layout uses featuredId for the large slot. Swap that
    // identity too, while keeping the actual session objects keyed by id so
    // their PTYs/xterm instances remain mounted and untouched.
    setFeaturedId((current) => {
      if (current === sourceId) return targetId
      if (current === targetId) return sourceId
      return current
    })
  }, [markLocalChange])

  const handleDragStart = useCallback((id: string): void => {
    setDraggedSessionId(id)
    setDropTargetId(null)
  }, [])

  const handleDragOver = useCallback((id: string): void => {
    setDropTargetId(id)
  }, [])

  const handleDragEnd = useCallback((): void => {
    setDraggedSessionId(null)
    setDropTargetId(null)
  }, [])

  const handlerCacheRef = useRef<Map<string, {
    onClose: () => void
    onProcessExit: () => void
    onFocus: () => void
    onRename: (title: string) => void
    onToggleMaximize: () => void
  }>>(new Map())

  const getSessionHandlers = (id: string) => {
    // Cached per id so SessionCard's memo actually holds: the underlying
    // callbacks (closeSession/finishSession/renameSession) only depend on the
    // stable markLocalChange, so a cached bundle never goes stale. Entries are
    // dropped by closeSession and swept by the effect below.
    const cached = handlerCacheRef.current.get(id)
    if (cached) return cached
    const handlers = {
        onClose: () => closeSession(id),
        onProcessExit: () => finishSession(id),
        onFocus: () => {
          markLocalChange()
          setFeaturedId(id)
        },
        onRename: (title: string) => renameSession(id, title),
        onToggleMaximize: () => {
          markLocalChange()
          setMaximizedId((current) => (current === id ? null : id))
        }
      }
    handlerCacheRef.current.set(id, handlers)
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

  // Columns scale with the actual session count. Three sessions get three
  // equal columns so the last card never leaves a large empty quadrant.
  const columns = sessions.length <= 1 ? 1 : sessions.length === 2 ? 2 : sessions.length <= 3 ? 3 : sessions.length <= 4 ? 2 : sessions.length <= 6 ? 3 : 4

  // With exactly 3 sessions a grid used to promote one terminal to a big
  // left slot (featured). That caused closing 1 of 4 → 3 to auto-promote
  // sessions[0] and make another card "fly" to the top-right. Disable the
  // automatic fallback — featured layout now only applies when the user has
  // explicitly clicked a small card to promote it.
  // Every session keeps the same grid parent and equal placement. This avoids
  // the old featured 2x2 arrangement, which left an empty quadrant at three.
  const placementOf = (_sessionId: string): React.CSSProperties => ({})

  return (
    <div
      // Above every canvas layer, below the title bar's z-[50000] — mirrors
      // BrowserPane's stacking so the view switcher stays reachable. Left
      // edge starts past the shared app sidebar (200px expanded outside chat —
      // see geometry.sidebarExpanded in design/tokens.ts; ChatPane uses the
      // 240px chat width) so the view content never floats underneath its
      // workspace controls.
      className={`absolute inset-y-0 right-0 left-[200px] z-[40000] flex flex-row pt-10 ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      aria-hidden={!active}
    >
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        <div className="flex h-9 flex-none items-center justify-between gap-2 border-b border-line-soft bg-bg-panel px-2.5">
          <p className="text-[11px] text-text-faint">
            {sessions.length === 0
              ? 'No code sessions running'
              : `${sessions.length} session${sessions.length > 1 ? 's' : ''}`}
          </p>
          <button
            type="button"
            onClick={() => setLauncherOpen(true)}
            className="flex items-center gap-1.5 rounded-[8px] border border-line-soft bg-bg-hover px-2.5 py-1 text-[12px] text-text transition-colors hover:bg-bg-hover"
          >
            <Plus size={13} strokeWidth={2.2} /> Launch
          </button>
        </div>

        {/* One grid for every layout — see placementOf() on why the featured
            arrangement is coordinates rather than a second container. Cards
            keep a 220px minimum and a 180px row floor; overflow scrolls instead
            of squeezing 7+ sessions unreadable. */}
        <div
          className="relative grid min-h-0 flex-1 gap-2 overflow-auto bg-bg-raise p-2"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(220px, 1fr))`, gridAutoRows: 'minmax(180px, 1fr)' }}
        >
          {sessions.map((session) => {
            const handlers = getSessionHandlers(session.id)
            return (
              <SessionCard
                key={session.id}
                session={session}
                style={placementOf(session.id)}
                onClose={handlers.onClose}
                onProcessExit={handlers.onProcessExit}
                onFocus={handlers.onFocus}
                onRename={handlers.onRename}
                onSwap={swapSessions}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                dragging={draggedSessionId === session.id}
                dropTarget={dropTargetId === session.id && draggedSessionId !== session.id}
                promotable={false}
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
      </div>

      {launcherOpen && (
        <CodeLauncher
          currentCount={sessions.length}
          onClose={() => setLauncherOpen(false)}
          onLaunch={launch}
        />
      )}
    </div>
  )
}
