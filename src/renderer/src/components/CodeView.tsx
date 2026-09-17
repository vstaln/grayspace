import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { codeWorkspaceScope } from '../../../shared/codeWorkspace'
import { ArrowLeftRight, Check, Copy, FolderOpen, Maximize2, Minimize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import TerminalWidget, { forgetTerminalViewport } from './TerminalWidget'
import BrowserWidget from './BrowserWidget'
import CodeLauncher, { CODE_AGENTS, CODE_LAUNCH_COUNTS, MAX_CODE_SESSIONS, CodeAgent } from './CodeLauncher'
import ResumeAgents from './ResumeAgents'
import RestoreSessionsDialog from './RestoreSessionsDialog'
import { needsRestorePrompt, splitRestore } from '../lib/restorePrompt'
import { codeGridLayout, type CodeLayoutMode } from '../lib/codeLayout'
import { upgradeSessionsToResume, type AgentConversation } from '../lib/agentConversations'
import { clearInitialCommand, queueInitialCommand, queueInitialCommandOnce } from '../lib/pendingTerminalCommands'
import { forgetAgentSelection } from './WidgetFrame'
import { attachmentAgent } from '../lib/terminalAttachments'
import { resolvePersistedAgent } from '../lib/persistedAgent'
import { setCodeSessionCount } from '../lib/codeSessions'
import { copyText } from '../lib/clipboard'

interface Session {
  id: string
  agent: CodeAgent
  title?: string
  status: 'active' | 'finished'
}

let sessionCounter = 0
const INLINE_AGENTS = CODE_AGENTS.filter((agent) => agent.id !== 'browser' && agent.id !== 'custom')

function makeSessionId(): string {
  sessionCounter += 1
  return `code-${Date.now()}-${sessionCounter}`
}

function agentForPersisted(agentId: string, label: string, command: string): CodeAgent {
  // The command is what the terminal actually starts; `resolvePersistedAgent`
  // owns the rules about which parts of a persisted session to trust.
  const resolved = resolvePersistedAgent(agentId, command, CODE_AGENTS)
  if (resolved) return { ...resolved.agent, command: resolved.command }

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

function setCodeDragImage(event: React.DragEvent, title: string): void {
  const preview = document.createElement('div')
  preview.className = 'code-drag-preview'
  preview.setAttribute('aria-hidden', 'true')

  const mark = document.createElement('span')
  mark.className = 'code-drag-preview-mark'
  mark.textContent = '↔'

  const label = document.createElement('span')
  label.textContent = title
  preview.append(mark, label)
  document.body.appendChild(preview)
  event.dataTransfer.setDragImage(preview, 16, 16)
  window.setTimeout(() => preview.remove(), 0)
}

function CodeDragCue({ source, target }: { source: Session; target: Session | null }): React.JSX.Element {
  const sourceTitle = source.title || source.agent.label
  const targetTitle = target ? target.title || target.agent.label : null
  const AgentIcon = source.agent.Icon

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center code-drag-cue"
      data-testid="code-drag-cue"
      role="status"
      aria-live="polite"
      aria-label={targetTitle ? `Swap ${sourceTitle} with ${targetTitle}` : `Drag ${sourceTitle} to swap`}
    >
      <div className="flex max-w-[min(360px,calc(100%-24px))] items-center gap-2 rounded-pill border border-text/35 bg-text/10 px-2 py-1 text-text shadow-[0_8px_26px_rgba(0,0,0,0.28)] backdrop-blur-md">
        <span className="grid h-5 w-5 flex-none place-items-center rounded-pill border border-text/30 bg-text/10">
          <AgentIcon size={12} />
        </span>
        <span className="max-w-[220px] truncate text-[11px] font-medium tracking-[0.01em]">
          {sourceTitle}
        </span>
        <span className="flex items-center gap-1 border-l border-text/25 pl-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-text/75">
          <ArrowLeftRight size={12} strokeWidth={2.2} />
          Swap
        </span>
      </div>
    </div>
  )
}

interface Props {


  active: boolean
  sidebarCollapsed: boolean
  terminalsFlipped: boolean
  layoutMode: CodeLayoutMode
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
  style,
  terminalsFlipped
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
  terminalsFlipped: boolean
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [nameCopied, setNameCopied] = useState(false)
  const mountedRef = useRef(true)
  const nameCopiedTimerRef = useRef<number | null>(null)
  const displayTitle = session.title || session.agent.label

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (nameCopiedTimerRef.current !== null) window.clearTimeout(nameCopiedTimerRef.current)
    }
  }, [])

  return (
    <div
      data-testid="code-session"
      data-session-agent={session.agent.id}
      className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-panel border border-bg-raise transition-[opacity,box-shadow] ${
        isBrowserSession(session) ? 'bg-bg-panel' : 'code-terminal-shell'
      } ${
        maximized ? 'absolute inset-0 z-20 rounded-bar' : ''
      } ${dragging ? 'opacity-65 ring-2 ring-text/70 ring-inset bg-text/5' : ''} ${dropTarget ? 'ring-2 ring-text/70 ring-inset bg-text/5' : ''}`}
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
          setCodeDragImage(e, displayTitle)
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
        <div className="group/title flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-text-dim">
          <span className="flex-none">
            <session.agent.Icon size={12} />
          </span>
          {editing ? (
            <input
              className="h-[20px] min-w-0 flex-1 appearance-none rounded-panel bg-bg-raise px-1.5 text-[11px] text-text outline-none ring-1 ring-line focus:outline-none"
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
            <>
              <span
                className="min-w-0 truncate cursor-default select-none hover:text-text"
                title="Double-click to rename"
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  setEditing(true)
                }}
              >
                {displayTitle}
              </span>
              {!isBrowserSession(session) && <button
                type="button"
                aria-label={`Copy terminal name ${displayTitle}`}
                title="Copy terminal name"
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void copyText(displayTitle).then((ok) => {
                    if (!ok || !mountedRef.current) return
                    setNameCopied(true)
                    if (nameCopiedTimerRef.current !== null) window.clearTimeout(nameCopiedTimerRef.current)
                    nameCopiedTimerRef.current = window.setTimeout(() => {
                      nameCopiedTimerRef.current = null
                      setNameCopied(false)
                    }, 1200)
                  })
                }}
                className="grid h-4 w-4 flex-none place-items-center rounded-pill text-text-faint opacity-0 transition-[opacity,color,background-color] group-hover/title:opacity-100 hover:bg-bg-hover hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
              >
                {nameCopied ? <Check size={10} /> : <Copy size={10} />}
              </button>}
            </>
          )}
        </div>
        <div className="flex flex-none items-center gap-0.5">
          {session.status === 'finished' && (
            <span
              className="flex flex-none items-center gap-1 rounded-pill border border-line-soft bg-bg-raise px-1.5 py-px text-[10px] text-text-faint"
              title="Process exited"
            >
              <span className="h-1.5 w-1.5 rounded-pill bg-text-faint" />
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
            className="grid h-[18px] w-[18px] place-items-center rounded-pill text-text-faint transition-colors hover:bg-accent/15 hover:text-text"
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
            className={`grid h-[18px] w-[18px] place-items-center rounded-panel transition-colors ${maximized ? 'bg-bg-hover text-white' : 'text-text-faint hover:bg-bg-hover hover:text-text'}`}
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
            className="grid h-[18px] w-[18px] place-items-center rounded-pill text-text-faint transition-colors hover:bg-bg-hover hover:text-text"
          >
            <X size={11} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-bg">
        {isBrowserSession(session)
          ? <BrowserWidget widgetId={session.id} onFullscreenChange={onFullscreenChange} />
          : <TerminalWidget id={session.id} surface="code" attachmentMode agentId={terminalAgentId(session)} flipped={terminalsFlipped} onProcessExit={onProcessExit} />}
      </div>
    </div>
  )
})

export default function CodeView({ active, sidebarCollapsed, terminalsFlipped, layoutMode }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  /**
   * A saved board waiting to be answered for: which of these terminals should
   * come back. Held out of `sessions` so nothing mounts, and no CLI starts,
   * until the user has said.
   */
  const [pendingRestore, setPendingRestore] = useState<
    { sessions: Session[]; featuredId: string | null; maximizedId: string | null } | null
  >(null)
  const pendingRestoreRef = useRef(pendingRestore)
  pendingRestoreRef.current = pendingRestore
  const sessionsRef = useRef<Session[]>(sessions)
  sessionsRef.current = sessions
  const [backgroundSessions, setBackgroundSessions] = useState<Session[]>([])
  const backgroundSessionsRef = useRef(backgroundSessions)
  backgroundSessionsRef.current = backgroundSessions
  const sessionScopesRef = useRef(new Map<string, string>())
  const [launcherOpen, setLauncherOpen] = useState(false)
  /**
   * The folder sessions run in. `null` while it is still being read, so the
   * launcher is not shown for a frame and then replaced by the folder picker —
   * which reads as a flash of the wrong screen on every open.
   */
  const [workspaceDir, setWorkspaceDir] = useState<string | null | undefined>(undefined)
  const workspaceDirRef = useRef(workspaceDir)
  workspaceDirRef.current = workspaceDir
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

  const resetColumnSplit = useCallback((): void => {
    setThreeWaySplit((prev) => {
      const next = { ...prev, col: 50 }
      try {
        localStorage.setItem('orcspace:code-three-way-split', JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

  const resetRowSplit = useCallback((): void => {
    setThreeWaySplit((prev) => {
      const next = { ...prev, row: 50 }
      try {
        localStorage.setItem('orcspace:code-three-way-split', JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

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
  const currentScope = (): string => codeWorkspaceScope(codeWorkspaceFolderRef.current, codeWorkspaceIdRef.current)
  const codeChangeSeqRef = useRef(0)
  const dirtyRef = useRef(false)

  const markLocalChange = useCallback(() => {
    codeChangeSeqRef.current += 1
    dirtyRef.current = true
  }, [])

  useEffect(() => {
    if (!maximizedId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable || target.closest('.xterm'))) {
          return
        }
        e.preventDefault()
        markLocalChange()
        setMaximizedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximizedId, markLocalChange])

  useEffect(() => {
    const flushSync = (): void => {
      if (!hydratedRef.current) return
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const seqAtSave = codeChangeSeqRef.current
      const payload = {
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
        codeWorkspaceId: codeWorkspaceIdRef.current,
        workspaceScope: currentScope()
      }
      if (typeof window.api.code.saveSync === 'function') {
        try {
          const result = window.api.code.saveSync(payload)
          if ('ok' in result && result.ok && codeChangeSeqRef.current === seqAtSave) dirtyRef.current = false
        } catch {}
      } else {
        void window.api.code.save(payload).then((result) => {
          if ('ok' in result && result.ok && codeChangeSeqRef.current === seqAtSave) dirtyRef.current = false
        }).catch(() => {})
      }
    }

    window.addEventListener('orcspace:before-code-workspace-switch', flushSync)
    window.addEventListener('beforeunload', flushSync)
    window.addEventListener('pagehide', flushSync)
    return () => {
      flushSync()
      window.removeEventListener('orcspace:before-code-workspace-switch', flushSync)
      window.removeEventListener('beforeunload', flushSync)
      window.removeEventListener('pagehide', flushSync)
    }
  }, [])

  /** Workspaces already answered for in this run of the app. */
  const answeredRestoreRef = useRef(new Set<string>())

  /**
   * The answer: the ticked terminals open and start, the rest are let go —
   * which also drops them from what is saved, so the board matches what is
   * actually running.
   */
  const applyRestore = useCallback((chosen: Set<string>): void => {
    const pending = pendingRestoreRef.current
    if (!pending) return
    const { start, drop } = splitRestore(pending.sessions, chosen)
    // Nothing here was ever mounted, so there is no terminal to dispose —
    // only the queued command and the per-session view state to forget.
    for (const session of drop) {
      clearInitialCommand(session.id)
      forgetTerminalViewport(session.id)
      forgetAgentSelection(session.id)
    }
    for (const session of start) {
      if (!isBrowserSession(session)) queueInitialCommandOnce(session.id, session.agent.command)
    }
    const ids = new Set(start.map((session) => session.id))
    const visibleIds = new Set([...ids, ...sessionsRef.current.map((session) => session.id)])
    // Answered: switching to another workspace and back does not ask again.
    answeredRestoreRef.current.add(currentScope())
    setPendingRestore(null)
    // A session started from the launcher while the question was open belongs
    // to the board too — answering must not take it away.
    setSessions((current) => [...start, ...current.filter((session) => !ids.has(session.id))])
    setFeaturedId(pending.featuredId && visibleIds.has(pending.featuredId) ? pending.featuredId : null)
    setMaximizedId(pending.maximizedId && visibleIds.has(pending.maximizedId) ? pending.maximizedId : null)
    // Whatever was let go has to leave the saved board too.
    hydratedRef.current = true
    dirtyRef.current = true
  }, [])

  const skipRestore = useCallback((): void => {
    applyRestore(new Set())
  }, [applyRestore])

  const hydrate = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    dirtyRef.current = false
    const run = ++hydrationRunRef.current
    const scope = currentScope()
    const changesAtStart = codeChangeSeqRef.current
    hydratedRef.current = false

    skipNextSaveRef.current = false

    setSessions([])
    setFeaturedId(null)
    setMaximizedId(null)
    setPendingRestore(null)
    // New scope: any in-flight HTML-fullscreen promotion belongs to the old
    // board. Without this, a browser left in fullscreen across a workspace
    // switch would clear the new board's manual maximize on its late leave.
    browserFullscreenActiveRef.current.clear()
    browserFullscreenDroveRef.current.clear()
    void window.api.code
      .load()
      .then(async (snapshot) => {
        if (run !== hydrationRunRef.current) return
        if (snapshot.workspaceScope && snapshot.workspaceScope !== scope) return
        if (codeChangeSeqRef.current !== changesAtStart) {
          hydratedRef.current = true

          skipNextSaveRef.current = false
          setSessions((current) => [...current])
          return
        }
        let restored: Session[] = (snapshot.sessions ?? []).map((s) => ({
          id: s.id,
          agent: agentForPersisted(s.agentId, s.label, s.command),
          title: s.title ?? s.label,
          status: 'active'
        }))

        // Auto-upgrade bare commands or finished sessions to resume where left off
        const folder =
          codeWorkspaceFolderRef.current ||
          workspaceDirRef.current ||
          (await window.api.workspace.getDir().catch(() => null))
        if (folder && restored.length > 0 && window.api.code.conversations) {
          try {
            const conversations = await window.api.code.conversations(folder)
            if (run !== hydrationRunRef.current) return
            if (Array.isArray(conversations) && conversations.length > 0) {
              const { sessions: upgradedSessions, upgraded } = upgradeSessionsToResume(restored, conversations)
              restored = upgradedSessions
              if (upgraded) dirtyRef.current = true
            }
          } catch {}
        }

        if (run !== hydrationRunRef.current || currentScope() !== scope) return
        if (codeChangeSeqRef.current !== changesAtStart) {
          hydratedRef.current = true
          setSessions((current) => [...current])
          return
        }
        // Running sessions retain their command and exit status; history
        // discovery is only allowed to upgrade sessions not already mounted.
        const retained = new Map(backgroundSessionsRef.current.map((session) => [session.id, session]))
        restored = restored.map((session) => retained.get(session.id) ?? session)
        let maxCounter = 0
        for (const s of restored) {
          const c = extractCounter(s.id)
          if (c !== null && c > maxCounter) maxCounter = c
        }
        if (maxCounter > sessionCounter) sessionCounter = maxCounter

        // A board with terminals in it is a question, not an instruction:
        // opening a folder must not launch a dozen agent CLIs on its own.
        // Asked once per workspace per run, so switching back and forth does
        // not keep asking about a board that has already been answered for.
        const workspaceKey = scope
        const retainedIds = new Set(backgroundSessionsRef.current.map((session) => session.id))
        const unmounted = restored.filter((session) => !retainedIds.has(session.id))
        if (needsRestorePrompt(unmounted) && !answeredRestoreRef.current.has(workspaceKey)) {
          const running = restored.filter((session) => retainedIds.has(session.id))
          setSessions(running)
          setBackgroundSessions((current) => current.filter((session) => !running.some((item) => item.id === session.id)))
          setPendingRestore({
            sessions: unmounted,
            featuredId: snapshot.featuredId ?? null,
            maximizedId: snapshot.maximizedId ?? null
          })
          // Nothing is saved until the answer comes: a board held in the
          // dialog must not be written back as an empty one.
          hydratedRef.current = false
          return
        }

        for (const session of restored) {
          if (session.status === 'active' && !isBrowserSession(session) && !retainedIds.has(session.id)) {
            queueInitialCommandOnce(session.id, session.agent.command)
          }
        }
        setSessions(restored)
        setBackgroundSessions((current) => current.filter((session) => !restored.some((item) => item.id === session.id)))
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
    let workspaceEventReceived = false
    void window.api.workspace
      .codeWorkspaces()
      .then((state) => {
        if (!mounted || workspaceEventReceived) return
        codeWorkspaceIdRef.current = state.activeId
        codeWorkspaceFolderRef.current = state.folder
        hydrate()
      })
      .catch(() => { if (mounted && !workspaceEventReceived) hydrate() })
    const unbindWorkspace = window.api.workspace.onCodeWorkspaceChange((state) => {
      workspaceEventReceived = true
      const previousScope = currentScope()
      const scopeChanged =
        codeWorkspaceIdRef.current !== state.activeId ||
        codeWorkspaceFolderRef.current !== state.folder
      codeWorkspaceIdRef.current = state.activeId
      codeWorkspaceFolderRef.current = state.folder
      // A rename also broadcasts the workspace state. Keep mounted sessions
      // alive for metadata-only changes; hydrate only when the saved slot
      // actually changes.
      if (scopeChanged) {
        // Keep the emulator parsing output and answering device queries while
        // its workspace is hidden. The PTY alone cannot answer those queries.
        const outgoing = sessionsRef.current
        for (const session of outgoing) sessionScopesRef.current.set(session.id, previousScope)
        setBackgroundSessions((current) => [...current.filter((session) => !outgoing.some((item) => item.id === session.id)), ...outgoing])
        sessionsRef.current = []
        hydrate()
      }
    })
    const unbindDeleted = window.api.workspace.onCodeWorkspaceDeleted((scope) => {
      const removed = new Set(Array.from(sessionScopesRef.current)
        .filter(([, owner]) => owner === scope).map(([id]) => id))
      if (scope === currentScope()) {
        for (const session of sessionsRef.current) removed.add(session.id)
        sessionsRef.current = []
        hydratedRef.current = false
        hydrationRunRef.current += 1
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        setSessions([])
        setPendingRestore(null)
      }
      setBackgroundSessions((current) => current.filter((session) => !removed.has(session.id)))
      answeredRestoreRef.current.delete(scope)
      for (const id of removed) {
        sessionScopesRef.current.delete(id)
        clearInitialCommand(id)
        forgetTerminalViewport(id)
        forgetAgentSelection(id)
      }
    })
    return () => {
      mounted = false
      hydrationRunRef.current += 1
      unbindWorkspace()
      unbindDeleted()
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
    const scopeAtSchedule = currentScope()
    const timer = setTimeout(() => {
      saveTimerRef.current = null
      if (currentScope() !== scopeAtSchedule) return
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
        codeWorkspaceId: workspaceIdAtSchedule,
        workspaceScope: scopeAtSchedule
      }
      const seqAtSave = codeChangeSeqRef.current
      void window.api.code.save(payload).then((result) => {
        if ('ok' in result && result.ok && codeChangeSeqRef.current === seqAtSave) dirtyRef.current = false
      }).catch(() => {})
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
      if (snapshot.workspaceScope && snapshot.workspaceScope !== currentScope()) return



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

  const launch = useCallback((agent: CodeAgent, count: number, title?: string): void => {
    markLocalChange()



    const amount = Math.min(count, Math.max(0, MAX_CODE_SESSIONS - sessionsRef.current.length))
    const created: Session[] = []
    for (let i = 0; i < amount; i++) {
      const id = makeSessionId()




      if (agent.id !== 'browser') queueInitialCommand(id, agent.command)
      created.push({ id, agent, title: title || agent.label, status: 'active' })
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

  /**
   * Reopens a past conversation: the same agent, started with its own resume
   * command, so the terminal comes up inside that conversation rather than a
   * new one. The command is persisted with the session, so a later restart
   * resumes it again instead of starting over.
   */
  const resumeConversation = useCallback((conversation: AgentConversation): void => {
    const base = CODE_AGENTS.find((agent) => agent.id === conversation.agentId)
    if (!base || !conversation.command.trim()) return
    // The header shows a truncated title anyway, and the store caps it too;
    // trimming here keeps what is displayed and what is saved identical.
    const title = conversation.title.trim().slice(0, 80) || `${base.label} session`
    launch({ ...base, command: conversation.command }, 1, title)
  }, [launch])

  const resumeConversations = useCallback((conversations: AgentConversation[]): void => {
    markLocalChange()
    let remaining = Math.max(0, MAX_CODE_SESSIONS - sessionsRef.current.length)
    const created: Session[] = []
    for (const conversation of conversations) {
      if (remaining <= 0) break
      const base = CODE_AGENTS.find((agent) => agent.id === conversation.agentId)
      if (!base || !conversation.command.trim()) continue
      const title = conversation.title.trim().slice(0, 80) || `${base.label} session`
      const id = makeSessionId()
      queueInitialCommand(id, conversation.command)
      created.push({
        id,
        agent: { ...base, command: conversation.command },
        title,
        status: 'active'
      })
      remaining -= 1
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
    browserFullscreenActiveRef.current.delete(id)
    browserFullscreenDroveRef.current.delete(id)
    sessionScopesRef.current.delete(id)
    setBackgroundSessions((current) => current.filter((session) => session.id !== id))
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
    clearInitialCommand(id)
    setBackgroundSessions((current) => current.map((session) =>
      session.id === id ? { ...session, status: 'finished' } : session
    ))
    if (!sessionsRef.current.some((session) => session.id === id)) return
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
    setDropTargetId(id === draggedSessionId ? null : id)
  }, [draggedSessionId])

  const handleDragEnd = useCallback((): void => {
    setDraggedSessionId(null)
    setDropTargetId(null)
  }, [])

  const draggedSession = draggedSessionId
    ? sessions.find((session) => session.id === draggedSessionId) ?? null
    : null
  const dropTargetSession = dropTargetId
    ? sessions.find((session) => session.id === dropTargetId && session.id !== draggedSessionId) ?? null
    : null

  const handlerCacheRef = useRef<Map<string, {
    onClose: () => void
    onProcessExit: () => void
    onFocus: () => void
    onRename: (title: string) => void
    onToggleMaximize: () => void
    onFullscreenChange: (active: boolean) => void
  }>>(new Map())
  // Tracks HTML-fullscreen separately from the manual Expand/Restore button
  // so leaving fullscreen never clears a maximize the user made themselves.
  const browserFullscreenActiveRef = useRef<Set<string>>(new Set())
  const browserFullscreenDroveRef = useRef<Set<string>>(new Set())

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
        },
        onFullscreenChange: (active: boolean) => handleBrowserFullscreen(id, active)
      }
    handlerCacheRef.current.set(id, handlers)
    return handlers
  }

  const handleBrowserFullscreen = useCallback((id: string, active: boolean): void => {
    if (active) {
      browserFullscreenActiveRef.current.add(id)
      // Already filling the workspace manually: stay maximized, but remember
      // we did NOT drive it so leave-html-full-screen won't restore it away.
      if (maximizedIdRef.current === id) return
      browserFullscreenDroveRef.current.add(id)
      markLocalChange()
      setMaximizedId(id)
    } else {
      browserFullscreenActiveRef.current.delete(id)
      if (!browserFullscreenDroveRef.current.has(id)) return
      browserFullscreenDroveRef.current.delete(id)
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








  // An explicit layout mode owns the whole grid; `auto` leaves the per-count
  // layout below (and its 3-way splitters) exactly as it was.
  const explicitLayout = useMemo(
    () => codeGridLayout(layoutMode, sessions.length, Math.max(0, sessions.findIndex((s) => s.id === featuredId))),
    [layoutMode, sessions, featuredId]
  )

  const sessionPlacements = useMemo(() => {
    const placements = new Map<string, React.CSSProperties>()

    if (explicitLayout) {
      sessions.forEach((session, index) => {
        placements.set(session.id, { ...explicitLayout.placement(index), order: index })
      })
      return placements
    }

    sessions.forEach((session, index) => {
      // `order` carries the slot for the layouts placementForIndex leaves to
      // auto-placement (1, 2, 4 and >20 sessions). Grid auto-placement follows
      // order-modified document order, so a swap is a style change rather than
      // a DOM move — see stableCardOrder below for why that matters.
      placements.set(session.id, { ...placementForIndex(sessions.length, index), order: index })
    })
    return placements
  }, [sessions, explicitLayout])

  /**
   * The order the cards are *rendered in*, which is deliberately not the order
   * they are laid out in.
   *
   * Swapping two sessions reorders the `sessions` array, and rendering straight
   * from it made React reorder the matching DOM nodes. A `<webview>` does not
   * survive that: detaching and re-attaching it destroys the guest process and
   * the page reloads from scratch — a video that had been playing for a minute
   * came back at zero. A terminal pays the same price in a PTY reconnect.
   *
   * So the DOM keeps every card at the position it first mounted at, for as
   * long as the session exists, and the visible arrangement is expressed purely
   * through the grid placement above.
   */
  const domOrderRef = useRef<string[]>([])
  const stableCardOrder = useMemo(() => {
    const present = [...sessions, ...backgroundSessions.filter((session) => !sessions.some((item) => item.id === session.id))]
    const byId = new Map(present.map((session) => [session.id, session] as const))
    const kept = domOrderRef.current.filter((id) => byId.has(id))
    for (const session of present) {
      if (!kept.includes(session.id)) kept.push(session.id)
    }
    domOrderRef.current = kept
    return kept.map((id) => byId.get(id)!)
  }, [sessions, backgroundSessions])

  const availableSessionSlots = Math.max(0, MAX_CODE_SESSIONS - sessions.length)
  const selectedSessionCount = Math.min(
    availableSessionSlots,
    Math.max(0, selectedAgentIds.reduce((total, id) => total + (agentCounts[id] ?? 1), 0))
  )

  return (
    <div
      className={`absolute inset-y-0 right-0 ${sidebarCollapsed ? 'left-0' : 'left-[200px]'} z-[40000] flex flex-row pt-10 bg-bg-raise ${
        active ? '' : 'pointer-events-none invisible'
      }`}
      data-testid="code-view"
      aria-hidden={!active}
    >
      <div className="relative flex min-w-0 min-h-0 flex-1 flex-col bg-bg-raise">
        {pendingRestore && (
          <RestoreSessionsDialog
            folderName={
              (codeWorkspaceFolderRef.current ?? workspaceDir ?? '').split(/[\\/]/).filter(Boolean).pop() ||
              'this folder'
            }
            sessions={pendingRestore.sessions}
            onRestore={applyRestore}
            onSkip={skipRestore}
          />
        )}
        <div ref={threeWayContainerRef} className={`relative grid min-h-0 flex-1 gap-0 bg-bg-raise p-0 ${maximizedId ? 'overflow-hidden' : 'overflow-auto'}`}
            style={maximizedId ? { gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'minmax(0, 1fr)' } : explicitLayout ? explicitLayout.container : sessions.length === 3 ? {
              gridTemplateColumns: `minmax(0, ${threeWaySplit.col}fr) 2px minmax(0, ${100 - threeWaySplit.col}fr)`,
              gridTemplateRows: `minmax(0, ${threeWaySplit.row}fr) 2px minmax(0, ${100 - threeWaySplit.row}fr)`
            } : { gridTemplateColumns, gridAutoRows: 'minmax(180px, 1fr)' }}
          >
            {draggedSession && <CodeDragCue source={draggedSession} target={dropTargetSession} />}
            {stableCardOrder.map((session) => {
              const hidden = !sessions.some((item) => item.id === session.id)
              const handlers = getSessionHandlers(session.id)
              const isMaximized = maximizedId === session.id
              // A maximized card is `absolute inset-0`: any gridColumn/gridRow
              // from placementForIndex would shrink its containing block to
              // that cell (counts 3, 5, 6-20), so it must not receive it.
              const placementStyle = isMaximized ? undefined : sessionPlacements.get(session.id)
              return (
                <SessionCard
                  key={session.id}
                  session={session}
                  style={hidden ? { display: 'none' } : placementStyle}
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
                  maximized={isMaximized}
                  onToggleMaximize={handlers.onToggleMaximize}
                  onFullscreenChange={handlers.onFullscreenChange}
                  terminalsFlipped={terminalsFlipped}
                />
              )
            })}
            {sessions.length === 3 && !maximizedId && !explicitLayout && <>
              <div
                data-testid="code-resize-columns"
                onMouseDown={handleStartColumnResize}
                onDoubleClick={resetColumnSplit}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    setThreeWaySplit((prev) => ({ ...prev, col: Math.max(20, prev.col - 5) }))
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    setThreeWaySplit((prev) => ({ ...prev, col: Math.min(80, prev.col + 5) }))
                  } else if (e.key === 'Home' || e.key === 'Enter') {
                    e.preventDefault()
                    resetColumnSplit()
                  }
                }}
                tabIndex={0}
                style={{ gridColumn: '2', gridRow: '1 / 4' }}
                className="group relative z-10 cursor-col-resize bg-line transition-colors hover:bg-line-soft active:bg-text-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                role="separator"
                aria-label="Resize columns"
                aria-valuenow={Math.round(threeWaySplit.col)}
                aria-valuemin={20}
                aria-valuemax={80}
              >
                <div className="absolute inset-y-0 -left-1 -right-1" />
              </div>
              <div
                data-testid="code-resize-rows"
                onMouseDown={handleStartRowResize}
                onDoubleClick={resetRowSplit}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setThreeWaySplit((prev) => ({ ...prev, row: Math.max(20, prev.row - 5) }))
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setThreeWaySplit((prev) => ({ ...prev, row: Math.min(80, prev.row + 5) }))
                  } else if (e.key === 'Home' || e.key === 'Enter') {
                    e.preventDefault()
                    resetRowSplit()
                  }
                }}
                tabIndex={0}
                style={{ gridColumn: '3', gridRow: '2' }}
                className="group relative z-10 cursor-row-resize bg-line transition-colors hover:bg-line-soft active:bg-text-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                role="separator"
                aria-label="Resize rows"
                aria-valuenow={Math.round(threeWaySplit.row)}
                aria-valuemin={20}
                aria-valuemax={80}
              >
                <div className="absolute inset-x-0 -top-1 -bottom-1" />
              </div>
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
                        className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-panel bg-text text-[14px] font-medium text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:opacity-40"
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
                                className="flex h-11 w-full items-center gap-3 rounded-panel border border-line-soft bg-bg-panel px-3.5 text-left transition-colors hover:border-line hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
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
                          className="ml-auto flex-none rounded-panel px-2.5 py-1.5 text-[12px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                        >
                          Change
                        </button>
                      </div>

                      <ResumeAgents
                        dir={workspaceDir}
                        remainingSlots={availableSessionSlots}
                        onResume={resumeConversation}
                        onResumeAll={resumeConversations}
                      />

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
                              className={`flex h-11 items-center gap-2.5 rounded-panel border px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line ${
                                selected
                                  ? 'border-line bg-bg-hover text-text'
                                  : 'border-line-soft bg-bg-panel text-text-dim hover:bg-bg-hover hover:text-text'
                              }`}
                            >
                              <span className="flex-none"><Icon size={15} /></span>
                              <span className="truncate text-[13px]">{agent.label}</span>
                              {selected && (
                                <span className="ml-auto h-[7px] w-[7px] flex-none rounded-pill bg-text" />
                              )}
                            </button>
                          )
                        })}
                      </div>

                      <button
                        type="button"
                        onClick={openLauncher}
                        data-testid="code-open-launcher"
                        className="mb-8 flex h-10 w-full items-center justify-center gap-2 rounded-panel border border-line-soft bg-bg-panel text-[12px] text-text-dim transition-colors hover:border-line hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                      >
                        <TerminalIcon size={14} />
                        Other CLI or browser
                      </button>

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
                                  className={`grid h-10 w-10 place-items-center rounded-panel border text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line ${
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
                        className="flex h-12 w-full items-center justify-center gap-2 rounded-panel bg-text text-[14px] font-medium text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-30"
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
