import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, Pencil, X } from 'lucide-react'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'
import TerminalWidget from './TerminalWidget'
import TimerWidget from './TimerWidget'
import PlannerWidget from './PlannerWidget'
import BoardWidget from './BoardWidget'
import OrchestrationWidget from './OrchestrationWidget'
import FilesWidget from './FilesWidget'
import SysMonitorWidget from './SysMonitorWidget'
import BrowserWidget from './BrowserWidget'
import LinksWidget from './LinksWidget'
import MusicPlayerWidget from './MusicPlayerWidget'
import ErrorBoundary from './ErrorBoundary'
import { useFocusTrap } from '../hooks/useFocusTrap'
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
  /** Natural process exit, not the user's close button — must not re-prompt
   *  "process will be terminated" about a process that is already dead. */
  onProcessExit: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  workspaceDir?: string | null
}

const AGENTS = [
  { id: 'antigravity', label: 'Antigravity', command: 'agy', Icon: AntigravityIcon },
  { id: 'claude', label: 'Claude', command: 'claude', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', command: 'codex', Icon: CodexIcon },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', Icon: OpenCodeIcon },
  { id: 'grok', label: 'Grok', command: 'grok', Icon: GrokIcon }
] as const

// A maximized widget is rendered in a different layer than a normal widget.
// Keep the toolbar selection outside WidgetFrame so moving between those
// layers cannot reset the selected agent to the first item in AGENTS.
// Bounded LRU to avoid unbounded memory on long sessions with many terminals.
const agentSelectionByWidget = new Map<string, number>()
const MAX_AGENT_SELECTION = 300
function rememberAgentSelection(widgetId: string, idx: number): void {
  agentSelectionByWidget.set(widgetId, idx)
  if (agentSelectionByWidget.size > MAX_AGENT_SELECTION) {
    const oldest = agentSelectionByWidget.keys().next().value as string | undefined
    if (oldest) agentSelectionByWidget.delete(oldest)
  }
}
export function forgetAgentSelection(widgetId: string): void {
  agentSelectionByWidget.delete(widgetId)
}

let cachedSubmit = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? '\r\n' : '\r'

/** Absolute positioning + cursor per edge/corner of the resizable frame. Hits are enlarged for touch/trackpad (UI-7). Handles sit above the header (z-30) so edge grabs win over header content. */
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
  // Renaming is only worth the header space for widgets that hold identifying
  // content of their own — a terminal session. The rest (Timer,
  // Planner, Board, Files, System Monitor, Browser, Links, Music Player, ID
  // Generator) are single-purpose utility panels whose default title already
  // says what they are, so the pencil/double-click affordance was just clutter.
  const canRename = isTerminal
  const canMaximize = !NON_MAXIMIZABLE.has((widget.kind ?? 'terminal') as WidgetKind)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [agentIdx, setAgentIdx] = useState(() => agentSelectionByWidget.get(widget.id) ?? 0)
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const agentPanelRef = useRef<HTMLDivElement>(null)
  const agent = AGENTS[agentIdx]
  const agentTrapRef = useRef<React.RefObject<HTMLDivElement>>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  // Anchor at menu-open time: if the widget moves (drag/resize) while the
  // portal menu is open, the menu closes instead of re-positioning per frame.
  const menuAnchorRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  const launchAgent = (): void => {
    setAgentLaunchError(null)
    void window.api.terminal
      .write(widget.id, `${agent.command}${cachedSubmit}`)
      .then((result) => {
        if (result && 'error' in result) setAgentLaunchError(result.error)
      })
      .catch((err) => {
        setAgentLaunchError(err instanceof Error ? err.message : String(err))
      })
  }

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

  useLayoutEffect(() => {
    if (!agentMenuOpen) return
    recomputeMenuPos()
    menuAnchorRef.current = { x: widget.x, y: widget.y, w: widget.w, h: widget.h }
  }, [agentMenuOpen, recomputeMenuPos])

  // Dragging/resizing the widget moves the anchor without a camera event —
  // close the portal menu on drag start instead of re-positioning it on every
  // drag frame (UI-3).
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

  // Focus the first menu item on open so the menu is keyboard-operable.
  useEffect(() => {
    if (!agentMenuOpen) return
    agentPanelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [agentMenuOpen, menuPos])

  // Camera pan/zoom moves the anchor without changing widget.x/y — close the menu instead of keeping a stale portal position (UI-3).
  useEffect(() => {
    if (!agentMenuOpen) return
    const onCameraMove = (): void => setAgentMenuOpen(false)
    window.addEventListener('orcspace:camera-move', onCameraMove)
    return () => window.removeEventListener('orcspace:camera-move', onCameraMove)
  }, [agentMenuOpen])

  // Terminal-only affordance (user request): double-click flips the shell to
  // fullscreen and back. Scoped so nothing else breaks: the title keeps its
  // double-click rename, buttons stay single-click, and a double-click that
  // just picked a word out of the scrollback (xterm selection) never toggles.
  // Blocked entirely for non-maximizable widgets (timer etc.).
  const onTerminalDoubleClick = (e: React.MouseEvent): void => {
    if (!canMaximize) return
    const target = e.target as HTMLElement
    if (target.closest('button, input, [data-testid="widget-title"]')) return
    if (window.getSelection()?.toString()) return
    onToggleMaximize()
  }

  useEffect(() => {
    if (!agentMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      // The panel lives in a portal under document.body, outside the anchor —
      // both subtrees must miss for this to count as an outside click.
      if (!agentMenuRef.current?.contains(t) && !agentPanelRef.current?.contains(t)) setAgentMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAgentMenuOpen(false)
    }
    // Panning/zooming the canvas moves the button on screen without firing a
    // mousedown (wheel-pan, ctrl/cmd+wheel zoom) and without changing
    // widget.x/widget.y (only camera.x/y/zoom do), so the position effect
    // above never reruns — the portal-rendered menu was left stuck at its old
    // screen coordinates, adrift from the button that opened it. Simplest fix
    // matching the click-outside/Escape behaviour above: a wheel while the
    // menu is open just closes it instead of trying to keep it glued to a
    // button whose canvas may have just moved out from under it.
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
      aria-roledescription="canvas widget"
      // The camera keeps its hands off a wheel tick that started inside a
      // widget by looking at the event target (App's onWheel checks for this
      // very attribute) — never by stopping propagation here. React delegates
      // its listeners to the root container, so a synthetic stopPropagation in
      // this frame also calls stopPropagation() on the *native* event while it
      // is still being dispatched at the root, above every widget. That killed
      // the tick before it could reach any native listener further down —
      // xterm's own wheel/mouse-report handlers and TerminalWidget's scrollback
      // handler among them — so no terminal could be scrolled at all.
      data-canvas-scroll-lock="true"
      onPointerDown={handlePointerDown}
      // P3-219: the frame is a keyboard stop — arrows move it, Alt+arrows
      // resize it, Delete closes it (handled in App's onFrameKey).
      tabIndex={0}
      role="group"
      aria-label={widget.title}
      onKeyDown={onKeyDown}
    >
      <div
        className="widget-header-shell relative z-30 flex h-[34px] flex-none cursor-grab items-center gap-1 py-0 pr-0 pl-2.5 active:cursor-grabbing"
        onPointerDown={handleHeaderPointerDown}
        onDoubleClick={isTerminal ? onTerminalDoubleClick : undefined}
      >
        {editing ? (
          <input
            aria-label="Widget title"
            className="h-[22px] min-w-0 flex-1 appearance-none rounded border border-transparent bg-transparent px-1.5 text-xs text-text outline-none focus:border-line focus:bg-bg-raise"
            autoFocus
            defaultValue={widget.title}
            onBlur={(e) => onRename(e.target.value.trim() || widget.title)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelEditing()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs text-text"
            data-testid="widget-title"
            onDoubleClick={canRename ? onStartEditing : undefined}
            title={canRename ? `${widget.title} — double-click to rename` : widget.title}
          >
            {widget.title}
          </span>
        )}
        {isTerminal && (
          <button
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={launchAgent}
            data-testid="widget-launch-agent"
            title={`Launch ${agent.label}`}
            aria-label={`Launch ${agent.label}`}
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
                  className="fixed z-[9800] flex min-w-[150px] flex-col overflow-hidden rounded-[10px] border border-line-soft bg-bg-panel py-1 shadow-lg"
                  style={{ left: menuPos.left, top: menuPos.top, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  // Portal bubbles through the widget tree to <main>; stopping
                  // only mousedown leaves pointerdown free to trigger the
                  // canvas draw/erase/pan gestures beneath the menu.
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
                    // Enter/Space activate natively — every item is a <button>.
                  }}
                >
                  {AGENTS.map((a, i) => (
                    <button
                      key={a.id}
                      role="menuitem"
                      className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors duration-150 hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60 focus:bg-bg-hover ${
                        i === agentIdx ? 'text-text' : 'text-text-dim'
                      }`}
                      onClick={() => {
                        rememberAgentSelection(widget.id, i)
                        setAgentIdx(i)
                        setAgentMenuOpen(false)
                      }}
                    >
                      <a.Icon size={13} />
                      <span className="truncate">{a.label}</span>
                    </button>
                  ))}
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
            onProcessExit={onProcessExit ?? onClose}
          />
        </ErrorBoundary>
      </div>
      {!widget.maximized &&
        RESIZE_HANDLES.map((dir) => (
          <div
            key={dir}
            className={`absolute ${HANDLE_CLASS[dir]}`}
            onPointerDown={(e) => onResizeStart(e, dir)}
          />
        ))}
    </div>
  )
}

/**
 * Which component fills the frame. A terminal is the fallback rather than an
 * explicit case: widgets restored from an older layout carry no `kind`, and
 * before other kinds existed every one of them was a terminal.
 */
function WidgetBody({
  widget,
  workspaceDir,
  onProcessExit
}: {
  widget: Widget
  workspaceDir?: string | null
  onProcessExit: () => void
}): React.JSX.Element {
  switch (widget.kind) {
    case 'timer':
      return <TimerWidget widgetId={widget.id} />
    case 'planner':
      return <PlannerWidget />
    case 'board':
      return <BoardWidget />
    case 'orchestration':
      return <OrchestrationWidget />
    case 'files':
      return <FilesWidget workspaceDir={workspaceDir} />
    case 'sys-monitor':
      return <SysMonitorWidget />
    case 'browser':
      return <BrowserWidget />
    case 'links':
      return <LinksWidget widgetId={widget.id} />
    case 'music-player':
      return <MusicPlayerWidget widgetId={widget.id} />
    default:
      return <TerminalWidget id={widget.id} surface="canvas" onProcessExit={onProcessExit} />
  }
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
    prev.style?.left === next.style?.left &&
    prev.style?.top === next.style?.top &&
    prev.style?.right === next.style?.right &&
    prev.style?.bottom === next.style?.bottom &&
    prev.style?.width === next.style?.width &&
    prev.style?.height === next.style?.height &&
    prev.style?.zIndex === next.style?.zIndex &&
    prev.style?.transform === next.style?.transform
  )
}

export default React.memo(WidgetFrame, areWidgetFramePropsEqual)

