import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
const INLINE_AGENTS = CODE_AGENTS.filter((agent) => agent.id !== 'browser' && agent.id !== 'custom')
const LAUNCH_COUNTS = [1, 2, 4, 6, 8, 10, 12]

function makeSessionId(): string {
  sessionCounter += 1
  return `code-${Date.now()}-${sessionCounter}`
}

function agentForPersisted(agentId: string, label: string, command: string): CodeAgent {
  const found = CODE_AGENTS.find((a) => a.id === agentId)
  if (found && found.command === command) return found
  if (found && agentId !== 'custom') return found

  return { id: agentId || 'custom', label: label || command || 'Other CLI', command, Icon: TerminalIcon }
}

function isBrowserSession(session: Pick<Session, 'agent'>): boolean {
  return session.agent.id === 'browser'
}

function extractCounter(id: string): number | null {
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
}

function denseRowCounts(count: number): number[] {
  const rows = count <= 8 || count === 10 ? 2 : count <= 15 ? 3 : 4
  if (count === 9) return [3, 3, 3]
  const perRow = Math.floor(count / rows)
  const remainder = count % rows
  return Array.from({ length: rows }, (_, row) => perRow + (row < remainder ? 1 : 0))
}

function placementForIndex(count: number, index: number): React.CSSProperties {
  if (count === 3) {
    if (index < 2) return { gridColumn: '1', gridRow: `${index + 1}` }
    return { gridColumn: '2', gridRow: '1 / span 2' }
  }
  if (count === 5) {
    if (index < 4) return { gridColumn: `${index % 2 + 1}`, gridRow: `${Math.floor(index / 2) + 1}` }
    return { gridColumn: '3', gridRow: '1 / span 2' }
  }
  if (count >= 6 && count <= 20) {
    let rowStart = 0
    for (const [row, terminalsInRow] of denseRowCounts(count).entries()) {
      if (index < rowStart + terminalsInRow) {
        const span = 60 / terminalsInRow
        return { gridColumn: `${(index - rowStart) * span + 1} / span ${span}`, gridRow: `${row + 1}` }
      }
      rowStart += terminalsInRow
    }
  }
  return {}
}

function clampSplit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(80, Math.max(20, value))
    : fallback
}

interface Props {


  active: boolean
  sidebarCollapsed?: boolean
}

const SessionCard = React.memo(function SessionCard({
  session,
  onClose,
  onProcessExit,
  onFocus,
  onRename,
  onOpenLauncher,
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
  onOpenLauncher(anchor: HTMLElement): void
  onSwap(sourceId: string, targetId: string): void
  onDragStart(id: string): void
  onDragOver(id: string): void
  onDragEnd(): void

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
      {


}
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
            aria-label="Open another CLI or browser"
            title="Open browser or another CLI"
            onClick={(e) => {
              e.stopPropagation()
              onOpenLauncher(e.currentTarget)
            }}
            className="grid h-[18px] w-[18px] place-items-center rounded-[4px] text-text-faint transition-colors hover:bg-accent/15 hover:text-text"
          >
            <Plus size={12} strokeWidth={2.5} />
          </button>
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
      <div className="min-h-0 flex-1 bg-[#080808]">
        {isBrowserSession(session) ? <BrowserWidget /> : <TerminalWidget id={session.id} surface="code" attachmentMode agentId={session.agent.id} onProcessExit={onProcessExit} />}
      </div>
    </div>
  )
})

export default function CodeView({ active, sidebarCollapsed = false }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const sessionsRef = useRef<Session[]>(sessions)
  sessionsRef.current = sessions
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({})
  const hadSessionsRef = useRef(false)
  const openLauncher = useCallback(() => setLauncherOpen(true), [])

  useEffect(() => {
    if (activeAgentId && selectedAgentIds.includes(activeAgentId)) return
    setActiveAgentId(selectedAgentIds[0] ?? null)
  }, [activeAgentId, selectedAgentIds])

  useEffect(() => {
    if (sessions.length > 0) {
      hadSessionsRef.current = true
      return
    }
    if (!hadSessionsRef.current) return
    hadSessionsRef.current = false
    setSelectedAgentIds([])
    setActiveAgentId(null)
    setAgentCounts({})
  }, [sessions.length])

  const [threeWaySplit, setThreeWaySplit] = useState<{ col: number; row: number }>(() => {
    try {
      const saved = localStorage.getItem('orcspace:code-three-way-split')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (typeof parsed?.col === 'number' && typeof parsed?.row === 'number') {
          return {
            col: clampSplit(parsed.col, 50),
            row: clampSplit(parsed.row, 50)
          }
        }
      }
    } catch {}
    return { col: 50, row: 50 }
  })
  const threeWayContainerRef = useRef<HTMLDivElement>(null)

  const handleStartColumnResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const container = threeWayContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const onMove = (moveEv: MouseEvent): void => {
      if (rect.width <= 0) return
      const colPx = moveEv.clientX - rect.left
      const col = Math.min(80, Math.max(20, (colPx / rect.width) * 100))
      setThreeWaySplit((prev) => {
        const next = { ...prev, col }
        try { localStorage.setItem('orcspace:code-three-way-split', JSON.stringify(next)) } catch {}
        return next
      })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleStartRowResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const container = threeWayContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const onMove = (moveEv: MouseEvent): void => {
      if (rect.height <= 0) return
      const rowPx = moveEv.clientY - rect.top
      const row = Math.min(80, Math.max(20, (rowPx / rect.height) * 100))
      setThreeWaySplit((prev) => {
        const next = { ...prev, row }
        try { localStorage.setItem('orcspace:code-three-way-split', JSON.stringify(next)) } catch {}
        return next
      })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const [featuredId, setFeaturedId] = useState<string | null>(null)
  const [maximizedId, setMaximizedId] = useState<string | null>(null)
  const featuredIdRef = useRef<string | null>(featuredId)
  const maximizedIdRef = useRef<string | null>(maximizedId)
  featuredIdRef.current = featuredId
  maximizedIdRef.current = maximizedId
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)




  useEffect(() => {
    const handleOpenLauncher = (): void => setLauncherOpen(true)
    window.addEventListener('orcspace:open-code-launcher', handleOpenLauncher)
    return () => window.removeEventListener('orcspace:open-code-launcher', handleOpenLauncher)
  }, [])
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




    skipNextSaveRef.current = false


    setSessions([])
    setFeaturedId(null)
    setMaximizedId(null)
    void window.api.code
      .load()
      .then((snapshot) => {
        if (run !== hydrationRunRef.current) return
        if (codeChangeSeqRef.current !== changesAtStart) {
          hydratedRef.current = true


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
        hydratedRef.current = true
      })
      .catch(() => {
        if (run !== hydrationRunRef.current) return

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


  useEffect(() => {
    return window.api.code.onChange((snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.sessions)) return



      if (!hydratedRef.current) return
      codeChangeSeqRef.current += 1

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




      setTimeout(() => {
        if (skipNextSaveRef.current) skipNextSaveRef.current = false
      }, 0)
    })
  }, [])

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



    const amount = Math.min(count, Math.max(0, MAX_CODE_SESSIONS - sessionsRef.current.length))
    const created: Session[] = []
    for (let i = 0; i < amount; i++) {
      const id = makeSessionId()




      if (agent.id !== 'browser') queueInitialCommand(id, agent.command)
      created.push({ id, agent, title: agent.label, status: 'active' })
    }
    if (created.length === 0) return
    setSessions((current) => {
      const room = Math.max(0, MAX_CODE_SESSIONS - current.length)
      return [...current, ...created.slice(0, room)]
    })
  }, [markLocalChange])

  const launchWorkspace = useCallback((): void => {
    let remaining = Math.max(0, MAX_CODE_SESSIONS - sessionsRef.current.length)
    for (const agentId of selectedAgentIds) {
      if (remaining <= 0) break
      const agent = INLINE_AGENTS.find((candidate) => candidate.id === agentId)
      if (!agent) continue
      const count = Math.min(agentCounts[agentId] ?? 1, remaining)
      launch(agent, count)
      remaining -= count
    }
  }, [agentCounts, launch, selectedAgentIds])

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



  const columns = sessions.length >= 6 && sessions.length <= 20
    ? 60
    : sessions.length === 3 || sessions.length === 5
      ? sessions.length === 3 ? 2 : 3
    : sessions.length <= 1 ? 1 : sessions.length === 2 ? 2 : sessions.length <= 4 ? 2 : sessions.length <= 6 ? 3 : sessions.length === 10 ? 5 : 4
  const gridTemplateColumns = sessions.length === 5
    ? '3fr 3fr 4fr'
    : `repeat(${columns}, minmax(0, 1fr))`








  const sessionPlacements = useMemo(() => {
    const placements = new Map<string, React.CSSProperties>()
    if (sessions.length === 3) return placements
    sessions.forEach((session, index) => {
      const style = placementForIndex(sessions.length, index)
      if (Object.keys(style).length > 0) placements.set(session.id, style)
    })
    return placements
  }, [sessions])

  const availableSessionSlots = Math.max(0, MAX_CODE_SESSIONS - sessions.length)
  const selectedSessionCount = Math.min(
    availableSessionSlots,
    Math.max(0, selectedAgentIds.reduce((total, id) => total + (agentCounts[id] ?? 1), 0))
  )

  return (
    <div
      className={`absolute inset-y-0 right-0 ${sidebarCollapsed ? 'left-[56px]' : 'left-[200px]'} z-[40000] flex flex-row pt-10 bg-[#121212] ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      data-testid="code-view"
      aria-hidden={!active}
    >
      <div className="flex min-w-0 min-h-0 flex-1 flex-col bg-[#121212]">
        {sessions.length > 0 && <div className="flex h-9 flex-none items-center justify-between border-b border-line bg-bg-panel px-3">
          <div className="flex items-center gap-2 text-xs text-text-dim">
            <span className="font-semibold text-text">{sessions.length}</span>
            <span>{sessions.length === 1 ? 'session' : 'sessions'}</span>
          </div>
          <button
            type="button"
            className="flex min-h-[28px] items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1 text-xs font-semibold text-bg transition hover:opacity-90 disabled:opacity-35"
            onClick={openLauncher}
            disabled={sessions.length >= MAX_CODE_SESSIONS}
          >
            <Plus size={13} strokeWidth={2.5} /> Launch
          </button>
        </div>}

        {sessions.length === 3 ? (
          <div
            ref={threeWayContainerRef}
            className="relative flex min-h-0 flex-1 overflow-hidden p-1 gap-1 bg-[#121212]"
          >
            <div style={{ width: `${threeWaySplit.col}%` }} className="min-w-0 h-full">
              {(() => {
                const s = sessions[0]
                const handlers = getSessionHandlers(s.id)
                return (
                  <SessionCard
                    key={s.id}
                    session={s}
                    onClose={handlers.onClose}
                    onProcessExit={handlers.onProcessExit}
                    onFocus={handlers.onFocus}
                    onRename={handlers.onRename}
                    onOpenLauncher={openLauncher}
                    onSwap={swapSessions}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    dragging={draggedSessionId === s.id}
                    dropTarget={dropTargetId === s.id && draggedSessionId !== s.id}
                    promotable={false}
                    maximized={maximizedId === s.id}
                    onToggleMaximize={handlers.onToggleMaximize}
                  />
                )
              })()}
            </div>

            <div
              data-testid="code-resize-columns"
              onMouseDown={handleStartColumnResize}
              className="relative z-10 w-2.5 flex-none cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
              role="separator"
              aria-label="Resize columns"
            />

            <div
              style={{ width: `calc(${100 - threeWaySplit.col}% - 10px)` }}
              className="min-w-0 h-full flex flex-col gap-1"
            >
              <div style={{ height: `${threeWaySplit.row}%` }} className="min-h-0 w-full">
                {(() => {
                  const s = sessions[1]
                  const handlers = getSessionHandlers(s.id)
                  return (
                    <SessionCard
                      key={s.id}
                      session={s}
                      onClose={handlers.onClose}
                      onProcessExit={handlers.onProcessExit}
                      onFocus={handlers.onFocus}
                      onRename={handlers.onRename}
                      onOpenLauncher={openLauncher}
                      onSwap={swapSessions}
                      onDragStart={handleDragStart}
                      onDragOver={handleDragOver}
                      onDragEnd={handleDragEnd}
                      dragging={draggedSessionId === s.id}
                      dropTarget={dropTargetId === s.id && draggedSessionId !== s.id}
                      promotable={false}
                      maximized={maximizedId === s.id}
                      onToggleMaximize={handlers.onToggleMaximize}
                    />
                  )
                })()}
              </div>

              <div
                data-testid="code-resize-rows"
                onMouseDown={handleStartRowResize}
                className="relative z-10 h-2.5 flex-none cursor-row-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
                role="separator"
                aria-label="Resize rows"
              />

              <div style={{ height: `calc(${100 - threeWaySplit.row}% - 10px)` }} className="min-h-0 w-full">
                {(() => {
                  const s = sessions[2]
                  const handlers = getSessionHandlers(s.id)
                  return (
                    <SessionCard
                      key={s.id}
                      session={s}
                      onClose={handlers.onClose}
                      onProcessExit={handlers.onProcessExit}
                      onFocus={handlers.onFocus}
                      onRename={handlers.onRename}
                      onOpenLauncher={openLauncher}
                      onSwap={swapSessions}
                      onDragStart={handleDragStart}
                      onDragOver={handleDragOver}
                      onDragEnd={handleDragEnd}
                      dragging={draggedSessionId === s.id}
                      dropTarget={dropTargetId === s.id && draggedSessionId !== s.id}
                      promotable={false}
                      maximized={maximizedId === s.id}
                      onToggleMaximize={handlers.onToggleMaximize}
                    />
                  )
                })()}
              </div>
            </div>
          </div>
        ) : (
          <div
            className="relative grid min-h-0 flex-1 gap-1 overflow-auto bg-[#121212] p-1"
            style={{ gridTemplateColumns, gridAutoRows: 'minmax(180px, 1fr)' }}
          >
            {sessions.map((session) => {
              const handlers = getSessionHandlers(session.id)
              return (
                <SessionCard
                  key={session.id}
                  session={session}
                  style={sessionPlacements.get(session.id)}
                  onClose={handlers.onClose}
                  onProcessExit={handlers.onProcessExit}
                  onFocus={handlers.onFocus}
                  onRename={handlers.onRename}
                  onOpenLauncher={openLauncher}
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
              <div className="flex min-h-full flex-1 justify-center overflow-auto bg-[#121212] px-6 pb-10">
                <div className="w-full max-w-[760px] translate-y-4 pt-[78px]">
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-text">Launch your workspace</h1>
                  <p className="mt-1.5 text-[13px] text-text-faint">Choose the CLIs you want to run together.</p>

                  <div className="mb-1.5 mt-8 text-[10px] font-semibold tracking-[0.12em] text-text-faint uppercase">CLI</div>
                  <div className="mb-5 grid grid-cols-3 gap-1.5">
                    {INLINE_AGENTS.map((agent) => {
                      const selected = selectedAgentIds.includes(agent.id)
                      const Icon = agent.Icon
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          aria-pressed={selected}
                          title={agent.label}
                          onClick={() => {
                            setSelectedAgentIds((current) => selected
                              ? current.filter((id) => id !== agent.id)
                              : [...current, agent.id])
                            if (!selected) setActiveAgentId(agent.id)
                            setAgentCounts((current) => ({ ...current, [agent.id]: current[agent.id] ?? 1 }))
                          }}
                          className={`flex h-[52px] items-center gap-3 rounded-[8px] border px-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 hover:border-line hover:bg-bg-hover hover:text-text ${selected ? 'border-accent bg-bg-raise text-text' : 'border-line-soft bg-bg-panel text-text-dim'}`}
                        >
                          <span className="grid h-8 w-8 flex-none place-items-center rounded-[6px] bg-[#111] text-text">
                            <Icon size={16} />
                          </span>
                          <span className="truncate text-[12px] font-medium">{agent.label}</span>
                        </button>
                      )
                    })}
                  </div>

                  {selectedAgentIds.length > 0 ? (
                    <>
                      <div className="mb-1 flex items-center justify-between">
                        <div className="text-[10px] font-semibold tracking-[0.12em] text-text-faint uppercase">
                          How many for {INLINE_AGENTS.find((agent) => agent.id === activeAgentId)?.label ?? 'CLI'}
                        </div>
                        <span className="text-[11px] text-text-faint">{selectedSessionCount} sessions</span>
                      </div>
                      <div className="mb-5 flex flex-wrap gap-1.5">
                        {LAUNCH_COUNTS.map((count) => (
                          <button
                            key={count}
                            type="button"
                            aria-pressed={(agentCounts[activeAgentId ?? ''] ?? 1) === count}
                            onClick={() => activeAgentId && setAgentCounts((current) => ({ ...current, [activeAgentId]: count }))}
                            className={`grid h-10 w-11 place-items-center rounded-[7px] border text-[13px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${(agentCounts[activeAgentId ?? ''] ?? 1) === count ? 'border-accent bg-bg-raise text-text' : 'border-line-soft bg-bg-panel text-text-dim hover:border-line hover:text-text'}`}
                          >
                            {count}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="mb-5 rounded-[7px] border border-line-soft bg-bg-panel px-3 py-3 text-[12px] text-text-faint">Choose a CLI first.</div>
                  )}

                  <button
                    type="button"
                    disabled={selectedAgentIds.length === 0 || selectedSessionCount === 0}
                    onClick={launchWorkspace}
                    className="flex h-12 w-full items-center justify-center gap-1.5 rounded-[9px] bg-white text-[14px] font-medium text-black transition hover:bg-white/90 active:scale-[.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:bg-[#666] disabled:text-black/80"
                  >
                    <Plus size={15} /> Launch {selectedSessionCount} sessions
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
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
