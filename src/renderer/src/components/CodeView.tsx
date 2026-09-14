import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import TerminalWidget, { forgetTerminalViewport } from './TerminalWidget'
import BrowserWidget from './BrowserWidget'
import CodeLauncher, { CODE_AGENTS, CODE_LAUNCH_COUNTS, CodeAgent } from './CodeLauncher'
import { clearInitialCommand, queueInitialCommand, queueInitialCommandOnce } from '../lib/pendingTerminalCommands'
import { forgetAgentSelection } from './WidgetFrame'
import { attachmentAgent } from '../lib/terminalAttachments'
import { setCodeSessionCount } from '../lib/codeSessions'

interface Session {
  id: string
  agent: CodeAgent
  title?: string
  status: 'active' | 'finished'
}

let sessionCounter = 0
const MAX_CODE_SESSIONS = 32
const INLINE_AGENTS = CODE_AGENTS.filter((agent) => agent.id !== 'browser' && agent.id !== 'custom')

function makeSessionId(): string {
  sessionCounter += 1
  return `code-${Date.now()}-${sessionCounter}`
}

function agentForPersisted(agentId: string, label: string, command: string): CodeAgent {
  // The command is what the terminal actually starts. Prefer its executable
  // over stale metadata so a session cannot display Codex while launching
  // Claude (or the other way around) after a migration or hand-edited state.
  const commandAgentId = attachmentAgent(command)
  const fromCommand = commandAgentId && CODE_AGENTS.find((a) => a.id === commandAgentId)
  if (fromCommand) return fromCommand

  const found = CODE_AGENTS.find((a) => a.id === agentId)
  if (found && found.command === command) return found
  if (found && agentId !== 'custom') return found

  return { id: agentId || 'custom', label: label || command || 'Other CLI', command, Icon: TerminalIcon }
}

function isBrowserSession(session: Pick<Session, 'agent'>): boolean {
  return session.agent.id === 'browser'
}

function terminalAgentId(session: Pick<Session, 'agent'>): string {
  // Custom launch commands can still point at a known CLI (including a
  // quoted Windows wrapper). Keep that useful detection, while built-in
  // selections remain authoritative and cannot be replaced by prompt text.
  return session.agent.id === 'custom'
    ? (attachmentAgent(session.agent.command) ?? session.agent.id)
    : session.agent.id
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
    return index === 0
      ? { gridColumn: '1', gridRow: '1 / 4' }
      : { gridColumn: '3', gridRow: index === 1 ? '1' : '3' }
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
  sidebarCollapsed: boolean
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
  onFullscreenChange,
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
  onFullscreenChange(active: boolean): void
  dragging?: boolean
  dropTarget?: boolean
  style?: React.CSSProperties
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || session.agent.label

  return (
    <div
      data-testid="code-session"
      data-session-agent={session.agent.id}
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[6px] border border-[#121212] transition-[opacity,box-shadow] ${
        isBrowserSession(session) ? 'bg-bg-panel' : 'code-terminal-shell'
      } ${
        maximized ? 'absolute inset-0 z-20 rounded-none' : ''
      } ${dragging ? 'opacity-45' : ''} ${dropTarget ? 'ring-2 ring-accent ring-inset' : ''}`}
      style={style}
      onDragOver={(e) => {
        if (editing || maximized) return
        if (!Array.from(e.dataTransfer.types).includes('text/session-id')) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        onDragOver(session.id)
      }}
      onDrop={(e) => {
        if (editing || maximized) return
        const sourceId = e.dataTransfer.getData('text/session-id')
        if (!sourceId) return
        e.preventDefault()
        e.stopPropagation()
        if (sourceId !== session.id) onSwap(sourceId, session.id)
        onDragEnd()
      }}
    >
      {


}
      <div
        draggable={!editing && !maximized}
        aria-grabbed={dragging || undefined}
        className={`code-session-header flex h-6 flex-none items-center justify-between gap-2 border-b border-line-soft px-1.5 ${
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
        onClick={(e) => {
          if (!editing) {
            onFocus?.()
            const termEl = e.currentTarget.parentElement?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
            termEl?.focus()
          }
        }}
        onDoubleClick={!editing ? onToggleMaximize : undefined}
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
            aria-pressed={maximized}
            onClick={(e) => {
              e.stopPropagation()
              onToggleMaximize()
            }}
            className={`grid h-[18px] w-[18px] place-items-center rounded-[4px] transition-colors ${maximized ? 'bg-bg-hover text-white' : 'text-text-faint hover:bg-bg-hover hover:text-text'}`}
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
        {isBrowserSession(session)
          ? <BrowserWidget onFullscreenChange={onFullscreenChange} />
          : <TerminalWidget id={session.id} surface="code" attachmentMode agentId={terminalAgentId(session)} onProcessExit={onProcessExit} />}
      </div>
    </div>
  )
})

export default function CodeView({ active, sidebarCollapsed }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const sessionsRef = useRef<Session[]>(sessions)
  sessionsRef.current = sessions
  const [launcherOpen, setLauncherOpen] = useState(false)
  /**
   * The folder sessions run in. `null` while it is still being read, so the
   * launcher is not shown for a frame and then replaced by the folder picker —
   * which reads as a flash of the wrong screen on every open.
   */
  const [workspaceDir, setWorkspaceDir] = useState<string | null | undefined>(undefined)
  const [recentDirs, setRecentDirs] = useState<{ path: string; name?: string }[]>([])
  const [pickingDir, setPickingDir] = useState(false)
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
  const splitRef = useRef(threeWaySplit)
  splitRef.current = threeWaySplit
  const splitDragCleanupRef = useRef<(() => void) | null>(null)

  // Both splitters previously ended their drag on `mouseup` alone. Releasing
  // the button outside the window (or the window losing focus mid-drag) never
  // delivers that event, so the divider stayed glued to the pointer with no
  // way out but another click, and its listeners outlived the drag — and the
  // component, if it unmounted while one was live. They also wrote the new
  // ratio to localStorage from inside the state updater: a synchronous,
  // disk-backed write for every mouse packet, and one React is free to run
  // twice per update. Persist once, on release.
  const startSplitDrag = useCallback(
    (axis: 'col' | 'row'): void => {
      const container = threeWayContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return

      const onMove = (moveEv: MouseEvent): void => {
        // The button being released off-window is not reported; the next
        // move that arrives with no buttons down is how we learn about it.
        if (moveEv.buttons === 0) {
          finish()
          return
        }
        const ratio =
          axis === 'col'
            ? ((moveEv.clientX - rect.left) / rect.width) * 100
            : ((moveEv.clientY - rect.top) / rect.height) * 100
        setThreeWaySplit((prev) => ({ ...prev, [axis]: Math.min(80, Math.max(20, ratio)) }))
      }
      const finish = (): void => {
        if (splitDragCleanupRef.current !== detach) return
        detach()
        try {
          localStorage.setItem('orcspace:code-three-way-split', JSON.stringify(splitRef.current))
        } catch {}
      }
      function detach(): void {
        splitDragCleanupRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', finish)
        window.removeEventListener('blur', finish)
      }

      splitDragCleanupRef.current?.()
      splitDragCleanupRef.current = detach
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', finish)
      window.addEventListener('blur', finish)
    },
    []
  )
  useEffect(() => () => splitDragCleanupRef.current?.(), [])

  const handleStartColumnResize = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      startSplitDrag('col')
    },
    [startSplitDrag]
  )

  const handleStartRowResize = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault()
      startSplitDrag('row')
    },
    [startSplitDrag]
  )

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
  const codeWorkspaceFolderRef = useRef<string | null>(null)
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
          if (session.status === 'active' && !isBrowserSession(session)) queueInitialCommandOnce(session.id, session.agent.command)
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
        codeWorkspaceFolderRef.current = state.folder
        hydrate()
      })
      .catch(() => { if (mounted) hydrate() })
    const unbindWorkspace = window.api.workspace.onCodeWorkspaceChange((state) => {
      const scopeChanged =
        codeWorkspaceIdRef.current !== state.activeId ||
        codeWorkspaceFolderRef.current !== state.folder
      codeWorkspaceIdRef.current = state.activeId
      codeWorkspaceFolderRef.current = state.folder
      // A rename also broadcasts the workspace state. Keep mounted sessions
      // alive for metadata-only changes; hydrate only when the saved slot
      // actually changes.
      if (scopeChanged) hydrate()
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
        if (session.status === 'active' && !isBrowserSession(session)) queueInitialCommandOnce(session.id, session.agent.command)
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

  // The folder, and anything the user has opened before. Both are read once
  // and kept current, because the picker below is the only way into Code when
  // no folder is set and a stale list there is a dead end.
  useEffect(() => {
    let alive = true
    void window.api.workspace.getDir().then((dir) => {
      if (alive) setWorkspaceDir(dir)
    }).catch(() => {
      if (alive) setWorkspaceDir(null)
    })
    void window.api.workspace.recent().then((dirs) => {
      if (alive) setRecentDirs(dirs)
    }).catch(() => {})
    const offDir = window.api.workspace.onDirChange((dir) => setWorkspaceDir(dir))
    const offRecent = window.api.workspace.onRecentChange((dirs) => setRecentDirs(dirs))
    return () => {
      alive = false
      offDir()
      offRecent()
    }
  }, [])

  /**
   * Tells the sidebar whether Code has anything running.
   *
   * The workspace panel is meaningless before the first session — there is
   * nothing to save a workspace *of*, and it repeats the folder line the
   * launcher already shows. An event rather than a prop because App tracks
   * "Code was opened", not "Code has sessions", and threading a second meaning
   * through it would make both harder to read.
   */
  useEffect(() => {
    setCodeSessionCount(sessions.length)
  }, [sessions.length])

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const dir = await window.api.workspace.pickDir()
      if (dir) setWorkspaceDir(dir)
    } catch {
      // Cancelling the OS dialog is the common case and is not an error.
    } finally {
      setPickingDir(false)
    }
  }, [pickingDir])

  const openRecentWorkspace = useCallback(async (path: string): Promise<void> => {
    try {
      const result = await window.api.workspace.openRecent(path)
      if (typeof result === 'string') setWorkspaceDir(result)
    } catch {
      // The folder may have been moved or deleted; the list refreshes itself.
    }
  }, [])

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
    // The session is gone; an undelivered launch command must not survive to
    // be typed into anything, and its id must not keep a slot in the queue.
    clearInitialCommand(id)
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

  const handleBrowserFullscreen = useCallback((id: string, active: boolean): void => {
    if (active) {
      markLocalChange()
      setMaximizedId(id)
    } else {
      setMaximizedId((current) => current === id ? null : current)
    }
  }, [markLocalChange])

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
      className={`absolute inset-y-0 right-0 ${sidebarCollapsed ? 'left-0' : 'left-[200px]'} z-[40000] flex flex-row pt-10 bg-[#121212] ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      data-testid="code-view"
      aria-hidden={!active}
    >
      <div className="flex min-w-0 min-h-0 flex-1 flex-col bg-[#121212]">
        <div ref={threeWayContainerRef} className="relative grid min-h-0 flex-1 gap-0 overflow-auto bg-[#121212] p-0"
            style={sessions.length === 3 ? {
              gridTemplateColumns: `minmax(0, ${threeWaySplit.col}fr) 2px minmax(0, ${100 - threeWaySplit.col}fr)`,
              gridTemplateRows: `minmax(0, ${threeWaySplit.row}fr) 2px minmax(0, ${100 - threeWaySplit.row}fr)`
            } : { gridTemplateColumns, gridAutoRows: 'minmax(180px, 1fr)' }}
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
                  onFullscreenChange={(active) => handleBrowserFullscreen(session.id, active)}
                />
              )
            })}
            {sessions.length === 3 && <>
              <div data-testid="code-resize-columns" onMouseDown={handleStartColumnResize}
                style={{ gridColumn: '2', gridRow: '1 / 4' }}
                className="z-10 cursor-col-resize hover:bg-bg-raise active:bg-bg-hover"
                role="separator" aria-label="Resize columns" />
              <div data-testid="code-resize-rows" onMouseDown={handleStartRowResize}
                style={{ gridColumn: '3', gridRow: '2' }}
                className="z-10 cursor-row-resize hover:bg-bg-raise active:bg-bg-hover"
                role="separator" aria-label="Resize rows" />
            </>}
            {sessions.length === 0 && (
              <div className="flex min-h-full flex-1 items-center justify-center overflow-auto bg-bg-raise px-6 py-12">
                <div className="w-full max-w-[640px]">
                  {workspaceDir === undefined ? null : !workspaceDir ? (
                    /*
                      No folder yet, so there is nothing to launch into and the
                      agent grid would be a decision the user cannot act on.
                      The folder comes first, and it is the only thing on screen.
                    */
                    <>
                      <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-text">
                        Choose a folder
                      </h1>
                      <p className="mt-1.5 text-[13px] text-text-faint">
                        Code sessions open inside it.
                      </p>

                      <button
                        type="button"
                        onClick={() => void chooseWorkspace()}
                        disabled={pickingDir}
                        data-testid="code-choose-folder"
                        className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-[11px] bg-text text-[14px] font-medium text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:opacity-40"
                      >
                        <FolderOpen size={16} />
                        {pickingDir ? 'Choosing…' : 'Choose folder'}
                      </button>

                      {recentDirs.length > 0 && (
                        <>
                          <div className="mt-9 mb-2.5 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">
                            Recent
                          </div>
                          <div className="space-y-1">
                            {recentDirs.slice(0, 5).map((dir) => (
                              <button
                                key={dir.path}
                                type="button"
                                title={dir.path}
                                onClick={() => void openRecentWorkspace(dir.path)}
                                className="flex h-11 w-full items-center gap-3 rounded-[9px] border border-line-soft bg-bg-panel px-3.5 text-left transition-colors hover:border-line hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                              >
                                <FolderOpen size={15} className="flex-none text-text-faint" />
                                <span className="truncate text-[13px] text-text">
                                  {dir.name || dir.path.split(/[\\/]/).filter(Boolean).pop() || dir.path}
                                </span>
                                <span className="ml-auto truncate pl-4 text-[12px] text-text-faint">
                                  {dir.path}
                                </span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {/*
                        The folder is settled, so it reads as a quiet line
                        rather than a control competing with the agent grid.
                      */}
                      <div className="mb-8 flex items-center gap-2.5">
                        <FolderOpen size={15} className="flex-none text-text-faint" />
                        <span className="min-w-0 truncate text-[13px] text-text-dim" title={workspaceDir}>
                          {workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir}
                        </span>
                        <button
                          type="button"
                          onClick={() => void chooseWorkspace()}
                          className="ml-auto flex-none rounded-[7px] px-2.5 py-1.5 text-[12px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                        >
                          Change
                        </button>
                      </div>

                      <div className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">
                        Agent
                      </div>
                      <div className="mb-8 grid grid-cols-3 gap-2">
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
                              className={`flex h-11 items-center gap-2.5 rounded-[9px] border px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line ${
                                selected
                                  ? 'border-line bg-bg-hover text-text'
                                  : 'border-line-soft bg-bg-panel text-text-dim hover:bg-bg-hover hover:text-text'
                              }`}
                            >
                              <span className="flex-none"><Icon size={15} /></span>
                              <span className="truncate text-[13px]">{agent.label}</span>
                              {selected && (
                                <span className="ml-auto h-[7px] w-[7px] flex-none rounded-full bg-text" />
                              )}
                            </button>
                          )
                        })}
                      </div>

                      {selectedAgentIds.length > 0 && (
                        <>
                          <div className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">
                            How many
                          </div>
                          <div className="mb-8 flex items-center gap-2">
                            {CODE_LAUNCH_COUNTS.map((count) => {
                              const current = (agentCounts[activeAgentId ?? ''] ?? 1) === count
                              return (
                                <button
                                  key={count}
                                  type="button"
                                  aria-pressed={current}
                                  onClick={() => activeAgentId && setAgentCounts((c) => ({ ...c, [activeAgentId]: count }))}
                                  className={`grid h-10 w-10 place-items-center rounded-[8px] border text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line ${
                                    current
                                      ? 'border-line bg-bg-hover text-text'
                                      : 'border-line-soft bg-bg-panel text-text-dim hover:bg-bg-hover hover:text-text'
                                  }`}
                                >
                                  {count}
                                </button>
                              )
                            })}
                            <span className="ml-2 text-[12px] text-text-faint">
                              for {INLINE_AGENTS.find((a) => a.id === activeAgentId)?.label ?? 'CLI'}
                            </span>
                          </div>

                          <div className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">
                            Will launch
                          </div>
                          <div className="mb-8 space-y-1.5">
                            {selectedAgentIds.map((id) => {
                              const agent = INLINE_AGENTS.find((a) => a.id === id)
                              if (!agent) return null
                              const Icon = agent.Icon
                              return (
                                <div key={id} className="flex h-9 items-center gap-3 px-0.5 text-[13px]">
                                  <span className="w-5 flex-none text-right text-text-faint">
                                    {agentCounts[id] ?? 1}
                                  </span>
                                  <span className="flex-none text-text-dim"><Icon size={15} /></span>
                                  <span className="truncate text-text-dim">{agent.label}</span>
                                </div>
                              )
                            })}
                          </div>
                        </>
                      )}

                      <button
                        type="button"
                        disabled={selectedAgentIds.length === 0 || selectedSessionCount === 0}
                        onClick={launchWorkspace}
                        data-testid="code-launch"
                        className="flex h-12 w-full items-center justify-center gap-2 rounded-[11px] bg-text text-[14px] font-medium text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Plus size={16} />
                        {selectedAgentIds.length === 0
                          ? 'Choose an agent'
                          : `Launch ${selectedSessionCount} session${selectedSessionCount === 1 ? '' : 's'}`}
                      </button>
                    </>
                  )}
                </div>
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
