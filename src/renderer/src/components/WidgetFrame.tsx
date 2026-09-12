import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, Pencil, X } from 'lucide-react'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'
import CursorIcon from './CursorIcon'
import KimiIcon from './KimiIcon'
import TerminalWidget from './TerminalWidget'
import { clearInitialCommand, queueInitialCommand, queueInitialCommandOnce } from '../lib/pendingTerminalCommands'
import { capOldest } from '../lib/boundedCache'
import TimerWidget from './TimerWidget'
import PlannerWidget from './PlannerWidget'
import OrchestrationWidget from './OrchestrationWidget'
import FilesWidget from './FilesWidget'
import SysMonitorWidget from './SysMonitorWidget'
import BrowserWidget from './BrowserWidget'
import LinksWidget from './LinksWidget'
import MusicPlayerWidget from './MusicPlayerWidget'
import ErrorBoundary from './ErrorBoundary'
import { NON_MAXIMIZABLE, RESIZE_HANDLES, ResizeDir, Widget, WidgetKind } from '../types'

interface Props {
  widget: Widget
  active: boolean
  editing: boolean
  style: React.CSSProperties
  onHeaderPointerDown: (e: React.PointerEvent) => void
  onResizeStart: (e: React.PointerEvent, dir: ResizeDir) => void
  onFocus: () => void
  onStartEditing: () => void
  onRename: (title: string) => void
  onCancelEditing: () => void
  onToggleMaximize: () => void
  onClose: () => void


  onProcessExit: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  workspaceDir?: string | null
}

const AGENTS = [
  { id: 'antigravity', label: 'Antigravity', command: 'agy', Icon: AntigravityIcon },
  { id: 'claude', label: 'Claude', command: 'claude', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', command: 'codex', Icon: CodexIcon },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', Icon: OpenCodeIcon },
  { id: 'grok', label: 'Grok Build', command: 'grok', Icon: GrokIcon },
  { id: 'kimi', label: 'Kimi Code', command: 'kimi', Icon: KimiIcon },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', Icon: CursorIcon },
] as const





const agentSelectionByWidget = new Map<string, number>()
const attachmentModeByWidget = new Set<string>()
const launchedAgentByWidget = new Map<string, string>()
const MAX_AGENT_SELECTION = 300

function agentStoreKey(widgetId: string): string {
  return `orcspace-agent-select:${widgetId}`
}
function attachStoreKey(widgetId: string): string {
  return `orcspace-attach:${widgetId}`
}
function launchedStoreKey(widgetId: string): string {
  return `orcspace-launched-agent:${widgetId}`
}
function loadPersistedAgent(widgetId: string): { idx: number; attached: boolean; launched?: string } {
  let idx = 0
  let attached = false
  let launched: string | undefined
  try {
    const rawIdx = localStorage.getItem(agentStoreKey(widgetId))
    if (rawIdx !== null) {
      const n = Number(rawIdx)
      if (Number.isFinite(n) && n >= 0 && n < AGENTS.length) idx = Math.floor(n)
    }
    attached = localStorage.getItem(attachStoreKey(widgetId)) === '1'
    launched = localStorage.getItem(launchedStoreKey(widgetId)) || undefined
  } catch {}
  return { idx, attached, launched }
}
// All three are keyed by widget id and cleared by `forgetAgentSelection`, but
// only the interactive close path calls that — a widget removed through `orc`,
// or one that disappears because another session edited the canvas, never
// reaches it. The cap keeps a long session from accumulating an entry per
// widget it has ever seen.
function rememberAgentSelection(widgetId: string, idx: number): void {
  agentSelectionByWidget.set(widgetId, idx)
  try { localStorage.setItem(agentStoreKey(widgetId), String(idx)) } catch {}
  capOldest(agentSelectionByWidget, MAX_AGENT_SELECTION)
}
function rememberAttachment(widgetId: string): void {
  attachmentModeByWidget.add(widgetId)
  try { localStorage.setItem(attachStoreKey(widgetId), '1') } catch {}
  capOldest(attachmentModeByWidget, MAX_AGENT_SELECTION)
}
function rememberLaunchedAgent(widgetId: string, agentId: string): void {
  launchedAgentByWidget.set(widgetId, agentId)
  try { localStorage.setItem(launchedStoreKey(widgetId), agentId) } catch {}
  capOldest(launchedAgentByWidget, MAX_AGENT_SELECTION)
}
export function forgetAgentSelection(widgetId: string): void {
  agentSelectionByWidget.delete(widgetId)
  attachmentModeByWidget.delete(widgetId)
  launchedAgentByWidget.delete(widgetId)
  clearInitialCommand(widgetId)
  try {
    localStorage.removeItem(agentStoreKey(widgetId))
    localStorage.removeItem(attachStoreKey(widgetId))
    localStorage.removeItem(launchedStoreKey(widgetId))
  } catch {}
}

const HANDLE_CLASS: Record<ResizeDir, string> = {
  n: 'top-0 right-3 left-3 h-3 cursor-ns-resize z-[40]',
  s: 'bottom-0 right-3 left-3 h-3 cursor-ns-resize z-[40]',
  e: 'top-3 right-0 bottom-3 w-3 cursor-ew-resize z-[40]',
  w: 'top-3 bottom-3 left-0 w-3 cursor-ew-resize z-[40]',
  ne: 'top-0 right-0 h-5 w-5 cursor-nesw-resize z-[40]',
  nw: 'top-0 left-0 h-5 w-5 cursor-nwse-resize z-[40]',
  se: 'bottom-0 right-0 h-5 w-5 cursor-nwse-resize z-[40]',
  sw: 'bottom-0 left-0 h-5 w-5 cursor-nesw-resize z-[40]'
}

function WidgetFrame({
  widget,
  active,
  editing,
  style,
  onHeaderPointerDown,
  onResizeStart,
  onFocus,
  onStartEditing,
  onRename,
  onCancelEditing,
  onToggleMaximize,
  onClose,
  onProcessExit,
  onKeyDown,
  workspaceDir
}: Props): React.JSX.Element {
  const isTerminal = !widget.kind || widget.kind === 'terminal'




  const canMaximize = !NON_MAXIMIZABLE.has((widget.kind ?? 'terminal') as WidgetKind)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [persisted] = useState(() => (isTerminal ? loadPersistedAgent(widget.id) : { idx: 0, attached: false, launched: undefined as string | undefined }))
  const [agentIdx, setAgentIdx] = useState(() => agentSelectionByWidget.get(widget.id) ?? persisted.idx)
  const [attachmentMode, setAttachmentMode] = useState(() => attachmentModeByWidget.has(widget.id) || persisted.attached)
  const [launchedAgentId, setLaunchedAgentId] = useState(() => launchedAgentByWidget.get(widget.id) ?? persisted.launched)
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const agentPanelRef = useRef<HTMLDivElement>(null)
  const agent = AGENTS[agentIdx]
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)


  const menuAnchorRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const launchingRef = useRef(false)
  const [isLaunching, setIsLaunching] = useState(false)

  const launchAgent = (): void => {
    if (launchingRef.current) return
    launchingRef.current = true
    setIsLaunching(true)
    setAgentLaunchError(null)
    // Single CR: pty expects one Enter. '\r\n' on Windows sends a double
    // submit (empty second prompt), the agent starts twice and the pty
    // looks hung. TerminalWidget uses '\r' for the same reason.
    const submit = '\r'
    void window.api.terminal
      .write(widget.id, `${agent.command}${submit}`)
      .then((result) => {
        const err = result && 'error' in result ? result.error : null
        if (err) {
          const missing = /not found|closed|disposed|no terminal/i.test(err)
          if (missing) {
            // Pty not ready yet (terminal:create still connecting):
            // queue in-memory only so the fresh pty runs it instead of
            // dropping the keystrokes. Do NOT persist: a transient failure
            // must not become a permanent auto-launch.
            queueInitialCommand(widget.id, agent.command)
            setAttachmentMode(true)
            setLaunchedAgentId(agent.id)
            return
          }
          // Real failure: do not leave the widget stuck in attachment mode,
          // otherwise every remount re-queues the agent and the user can
          // never type into a plain shell again.
          forgetAgentSelection(widget.id)
          setAttachmentMode(false)
          setLaunchedAgentId(undefined)
          setAgentLaunchError(err)
          return
        }
        rememberAttachment(widget.id)
        rememberLaunchedAgent(widget.id, agent.id)
        setAttachmentMode(true)
        setLaunchedAgentId(agent.id)
      })
      .catch((err) => {
        forgetAgentSelection(widget.id)
        setAttachmentMode(false)
        setLaunchedAgentId(undefined)
        setAgentLaunchError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        launchingRef.current = false
        setIsLaunching(false)
      })
  }

  // Restore a previously launched agent after restart: queue its command so a
  // fresh pty re-runs it, while a still-live pty (renderer reload) discards it.
  const restoreQueuedRef = useRef(false)
  useEffect(() => {
    if (restoreQueuedRef.current) return
    if (!isTerminal) return
    restoreQueuedRef.current = true
    const persistedLaunched = launchedAgentByWidget.get(widget.id) ?? persisted.launched
    if (!persistedLaunched) return
    const entry = AGENTS.find((a) => a.id === persistedLaunched)
    // Once-only: a remount of a widget whose agent already started must not
    // type the command into the session that is already running it.
    if (entry) queueInitialCommandOnce(widget.id, entry.command)
  }, [isTerminal, widget.id, persisted])

  const stopAgentAutoLaunch = useCallback(() => {
    forgetAgentSelection(widget.id)
    setAttachmentMode(false)
    setLaunchedAgentId(undefined)
  }, [widget.id])

  useEffect(() => {
    const onAgentExit = (event: Event): void => {
      const detail = (event as CustomEvent<{ widgetId?: string }>).detail
      if (detail?.widgetId !== widget.id) return
      forgetAgentSelection(widget.id)
      setLaunchedAgentId(undefined)
    }
    window.addEventListener('orcspace:agent-exited', onAgentExit)
    return () => window.removeEventListener('orcspace:agent-exited', onAgentExit)
  }, [widget.id])

  const recomputeMenuPos = useCallback(() => {
    const rect = agentMenuRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 150
    const height = agentPanelRef.current?.getBoundingClientRect().height ?? 180
    const below = rect.bottom + 4
    const top = below + height > window.innerHeight
      ? Math.max(4, rect.top - height - 4)
      : below
    setMenuPos({
      left: Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4)),
      top
    })
  }, [])



  const agentMenuWasOpenRef = useRef(false)
  useEffect(() => {
    if (!agentMenuOpen) {
      if (agentMenuWasOpenRef.current) {
        agentMenuWasOpenRef.current = false
        agentMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      }
      return
    }
    agentMenuWasOpenRef.current = true
    const frame = requestAnimationFrame(recomputeMenuPos)
    return () => cancelAnimationFrame(frame)
  }, [agentMenuOpen, recomputeMenuPos])

  useLayoutEffect(() => {
    if (!agentMenuOpen) return
    recomputeMenuPos()
    menuAnchorRef.current = { x: widget.x, y: widget.y, w: widget.w, h: widget.h }
  }, [agentMenuOpen, recomputeMenuPos])




  useLayoutEffect(() => {
    if (!agentMenuOpen) return
    const anchor = menuAnchorRef.current
    if (
      anchor &&
      (anchor.x !== widget.x || anchor.y !== widget.y || anchor.w !== widget.w || anchor.h !== widget.h)
    ) {
      setAgentMenuOpen(false)
    }
  }, [agentMenuOpen, widget.x, widget.y, widget.w, widget.h])


  useEffect(() => {
    if (!agentMenuOpen) return
    agentPanelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [agentMenuOpen, menuPos])


  useEffect(() => {
    if (!agentMenuOpen) return
    const onCameraMove = (): void => setAgentMenuOpen(false)
    window.addEventListener('orcspace:camera-move', onCameraMove)
    return () => window.removeEventListener('orcspace:camera-move', onCameraMove)
  }, [agentMenuOpen])






  useEffect(() => {
    if (!agentMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node


      if (!agentMenuRef.current?.contains(t) && !agentPanelRef.current?.contains(t)) setAgentMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAgentMenuOpen(false)
    }








    const onWheel = (): void => setAgentMenuOpen(false)
    const onResize = (): void => setAgentMenuOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', onResize)
    }
  }, [agentMenuOpen])

  const handlePointerDown = (e: React.PointerEvent): void => {
    onFocus()
    if (isTerminal && !editing) {
      const target = e.target as HTMLElement | null
      if (!target?.closest('button, input, [role="menu"]')) {
        const termEl = (e.currentTarget as HTMLElement).querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        termEl?.focus()
      }
    }
  }

  const handleHeaderPointerDown = (e: React.PointerEvent): void => {
    onHeaderPointerDown(e)
    if (isTerminal && !editing) {
      const target = e.target as HTMLElement | null
      if (!target?.closest('button, input, [role="menu"]')) {
        const termEl = (e.currentTarget.parentElement as HTMLElement)?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        termEl?.focus()
      }
    }
  }

  return (
    <div
      className={[
        'widget-shell widget absolute flex flex-col overflow-hidden rounded-[10px]',
        isTerminal ? 'is-terminal' : '',
        isTerminal ? 'is-canvas-terminal' : '',
        active ? 'is-active' : ''
      ].join(' ')}
      style={style}
      data-testid={`widget-${widget.kind ?? 'terminal'}-${widget.id}`}
      data-widget-id={widget.id}
      aria-roledescription="canvas widget"









      data-canvas-scroll-lock="true"
      onPointerDown={handlePointerDown}


      tabIndex={0}
      role="group"
      aria-label={widget.title}
      onKeyDown={onKeyDown}
    >
      <div
        className="widget-header-shell relative z-50 flex h-[34px] flex-none cursor-grab items-center gap-1 py-0 pr-0 pl-2.5 active:cursor-grabbing"
        onPointerDown={handleHeaderPointerDown}
      >
        {editing ? (
          <input
            aria-label="Widget title"
            data-testid="widget-title-input"
            className="h-[22px] min-w-0 flex-1 appearance-none rounded border border-transparent bg-transparent px-1.5 text-xs text-text outline-none focus:border-line focus:bg-bg-raise"
            autoFocus
            defaultValue={widget.title}
            onBlur={(e) => onRename(e.target.value.trim() || widget.title)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelEditing()
              if (e.key === 'Enter') {
                e.preventDefault()
                const input = e.currentTarget as HTMLInputElement
                onRename(input.value.trim() || widget.title)
                input.blur()
              }
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs text-text"
            data-testid="widget-title"
            title={`${widget.title} (double-click to rename)`}
            onPointerDown={(e) => {
              if (e.detail >= 2) {
                e.preventDefault()
                e.stopPropagation()
                onStartEditing()
              }
            }}
            onClick={(e) => {
              // Electron can suppress dblclick when the header owns pointer
              // capture. The second click still carries detail=2, so handle
              // it directly as a reliable rename entry point.
              if (e.detail >= 2) {
                e.stopPropagation()
                onStartEditing()
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onStartEditing()
            }}
          >
            {widget.title}
          </span>
        )}
        {isTerminal && (
          <button
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60 disabled:opacity-40"
            onClick={launchAgent}
            disabled={isLaunching}
            data-testid="widget-launch-agent"
            title={isLaunching ? 'Launching…' : `Launch ${agent.label}`}
            aria-label={isLaunching ? 'Launching…' : `Launch ${agent.label}`}
          >
            <agent.Icon size={13} />
          </button>
        )}
        {isTerminal && agentLaunchError && (
          <span
            role="alert"
            className="absolute top-[34px] right-2 z-[60] max-w-[70%] truncate rounded-[8px] border border-danger/40 bg-bg-panel px-2 py-1 text-[10px] text-danger shadow-lg"
            title={agentLaunchError}
          >
            {agentLaunchError}
          </span>
        )}
        {isTerminal && (
          <div className="relative" ref={agentMenuRef}>
            <button
              className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
              data-canvas-interactive="true"
              onPointerDownCapture={(e) => e.stopPropagation()}
              onClick={() => setAgentMenuOpen((v) => !v)}
              data-testid="widget-agent-menu"
              title="Select Agent"
              aria-label="Select Agent"
              aria-haspopup="menu"
              aria-expanded={agentMenuOpen}
            >
              <Pencil size={11} strokeWidth={1.5} />
            </button>
            {agentMenuOpen &&
              menuPos &&
              createPortal(
                <div
                  ref={agentPanelRef}
                  role="menu"
                  aria-label="Agent"
                  data-canvas-interactive="true"
                  className="fixed z-[9800] flex min-w-[150px] flex-col overflow-hidden rounded-[10px] border border-line-soft bg-bg-panel py-1 shadow-lg"
                  style={{ left: menuPos.left, top: menuPos.top, WebkitAppRegion: 'no-drag' } as React.CSSProperties}



                  onPointerDownCapture={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    const items = Array.from(
                      agentPanelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
                    )
                    if (items.length === 0) return
                    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      items[(idx + 1) % items.length]?.focus()
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      items[(idx - 1 + items.length) % items.length]?.focus()
                    } else if (e.key === 'Home') {
                      e.preventDefault()
                      items[0]?.focus()
                    } else if (e.key === 'End') {
                      e.preventDefault()
                      items[items.length - 1]?.focus()
                    }

                  }}
                >
                  {AGENTS.map((a, i) => (
                    <button
                      key={a.id}
                      role="menuitem"
                      data-canvas-interactive="true"
                      className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors duration-150 hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60 focus:bg-bg-hover ${
                        i === agentIdx ? 'text-text' : 'text-text-dim'
                      }`}
                      onClick={() => {
                        rememberAgentSelection(widget.id, i)
                        setAgentIdx(i)
                        setAgentMenuOpen(false)
                      }}
                    >
                      <span className="flex h-[13px] w-[13px] flex-none items-center justify-center">
                        <a.Icon size={13} />
                      </span>
                      <span className="truncate">{a.label}</span>
                    </button>
                  ))}
                    <button
                      role="menuitem"
                      data-canvas-interactive="true"
                      className="flex items-center gap-2 border-t border-line-soft px-3 py-1.5 text-left text-xs text-text-dim outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60 focus:bg-bg-hover"
                      onClick={() => {
                        stopAgentAutoLaunch()
                        setAgentMenuOpen(false)
                      }}
                    >
                      <span className="truncate">Plain shell (stop auto-launch)</span>
                    </button>
                </div>,
                document.body
              )}
          </div>
        )}
        <div className="ml-1 flex h-[34px] flex-none items-center">
          {canMaximize ? (
            <button
              className="grid h-full w-8 place-items-center text-text-dim outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
              onClick={onToggleMaximize}
              data-testid="widget-maximize"
              title={widget.maximized ? 'Restore' : 'Maximize'}
              aria-label={widget.maximized ? 'Restore' : 'Maximize'}
            >
              {widget.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          ) : (
            <span
              className="grid h-full w-8 cursor-not-allowed place-items-center text-text-faint/40"
              data-testid="widget-maximize"
              title="Cannot be maximized"
              aria-label="Cannot be maximized"
              aria-disabled="true"
            >
              <Maximize2 size={13} />
            </span>
          )}
          <button
            className="grid h-full w-8 place-items-center rounded-tr-[10px] text-text-dim outline-none transition-colors duration-150 hover:bg-[#e04343] hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={onClose}
            data-testid="widget-close"
            title="Close"
            aria-label="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="widget-body min-h-0 flex-1 bg-transparent">
        <ErrorBoundary>
          <WidgetBody
            widget={widget}
            workspaceDir={workspaceDir}
            attachmentMode={attachmentMode}
            agentId={launchedAgentId ?? (agent?.id === 'codex' ? 'codex' : undefined)}
            onProcessExit={onProcessExit ?? onClose}
          />
        </ErrorBoundary>
      </div>
      {!widget.maximized &&
        RESIZE_HANDLES.map((dir) => (
          <div
            key={dir}
            role="separator"
            aria-label={`Resize ${dir === 'n' ? 'up' : dir === 's' ? 'down' : dir === 'e' ? 'right' : dir === 'w' ? 'left' : dir}`}
            aria-orientation={dir === 'n' || dir === 's' ? 'horizontal' : dir === 'e' || dir === 'w' ? 'vertical' : undefined}
            aria-valuetext={`${Math.round(widget.w)} by ${Math.round(widget.h)}`}
            tabIndex={0}
            className={`absolute ${HANDLE_CLASS[dir]} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60`}
            onPointerDown={(e) => onResizeStart(e, dir)}
          />
        ))}
    </div>
  )
}






function WidgetBody({
  widget,
  workspaceDir,
  attachmentMode,
  agentId,
  onProcessExit
}: {
  widget: Widget
  workspaceDir?: string | null
  attachmentMode: boolean
  agentId?: string
  onProcessExit: () => void
}): React.JSX.Element {
  switch (widget.kind) {
    case 'timer':
      return <TimerWidget widgetId={widget.id} />
    case 'planner':
      return <PlannerWidget />
    case 'orchestration':
      return <OrchestrationWidget />
    case 'files':
      return <FilesWidget workspaceDir={workspaceDir} />
    case 'sys-monitor':
      return <SysMonitorWidget />
    case 'browser':
      return <BrowserWidget widgetId={widget.id} />
    case 'links':
      return <LinksWidget widgetId={widget.id} />
    case 'music-player':
      return <MusicPlayerWidget widgetId={widget.id} />
    default:
      return <TerminalWidget id={widget.id} surface="canvas" attachmentMode={attachmentMode} agentId={agentId} onProcessExit={onProcessExit} />
  }
}

function shallowStyleEqual(a?: React.CSSProperties | null, b?: React.CSSProperties | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

function areWidgetFramePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.widget === next.widget &&
    prev.active === next.active &&
    prev.editing === next.editing &&
    prev.workspaceDir === next.workspaceDir &&
    prev.onClose === next.onClose &&
    prev.onFocus === next.onFocus &&
    prev.onStartEditing === next.onStartEditing &&
    prev.onRename === next.onRename &&
    prev.onCancelEditing === next.onCancelEditing &&
    prev.onToggleMaximize === next.onToggleMaximize &&
    prev.onProcessExit === next.onProcessExit &&
    prev.onKeyDown === next.onKeyDown &&
    prev.onHeaderPointerDown === next.onHeaderPointerDown &&
    prev.onResizeStart === next.onResizeStart &&
    shallowStyleEqual(prev.style, next.style)
  )
}

export default React.memo(WidgetFrame, areWidgetFramePropsEqual)

