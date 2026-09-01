import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { RESIZE_HANDLES, ResizeDir, Widget, WidgetKind } from '../types'

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
const agentSelectionByWidget = new Map<string, number>()

let cachedSubmit = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? '\r\n' : '\r'

/** Absolute positioning + cursor per edge/corner of the resizable frame. */
const HANDLE_CLASS: Record<ResizeDir, string> = {
  n: 'top-0 right-3 left-3 h-2 cursor-ns-resize z-10',
  s: 'bottom-0 right-3 left-3 h-2 cursor-ns-resize z-10',
  e: 'top-3 right-0 bottom-3 w-2 cursor-ew-resize z-10',
  w: 'top-3 bottom-3 left-0 w-2 cursor-ew-resize z-10',
  ne: 'top-0 right-0 h-3.5 w-3.5 cursor-nesw-resize z-20',
  nw: 'top-0 left-0 h-3.5 w-3.5 cursor-nwse-resize z-20',
  se: 'bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize z-20',
  sw: 'bottom-0 left-0 h-3.5 w-3.5 cursor-nesw-resize z-20'
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
  // content of their own — a terminal session or a note. The rest (Timer,
  // Planner, Board, Files, System Monitor, Browser, Links, Music Player, ID
  // Generator) are single-purpose utility panels whose default title already
  // says what they are, so the pencil/double-click affordance was just clutter.
  const canRename = isTerminal
  // Timer, Links, Files, Music Player, Orchestration have no benefit from
  // fullscreen — stretching them to the whole canvas just leaves empty space.
  // Disable the entire maximize path, not just the button: double-click,
  // keyboard, and programmatic toggles are all blocked (user: "не просто кнопку").
  const NON_MAXIMIZABLE: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
    'timer',
    'links',
    'files',
    'music-player',
    'orchestration'
  ])
  const canMaximize = !NON_MAXIMIZABLE.has((widget.kind ?? 'terminal') as WidgetKind)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [agentIdx, setAgentIdx] = useState(() => agentSelectionByWidget.get(widget.id) ?? 0)
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const agent = AGENTS[agentIdx]
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)

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

  useLayoutEffect(() => {
    if (!agentMenuOpen) return
    const rect = agentMenuRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 150
    setMenuPos({
      left: Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4)),
      top: rect.bottom + 4
    })
    // The widget can move/resize while the menu is open; recompute the anchor
    // against its live rect instead of keeping a stale position. Width moves
    // the anchor's right edge, height its bottom — both belong here (UI-audit).
  }, [agentMenuOpen, widget.x, widget.y, widget.w, widget.h])

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
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) setAgentMenuOpen(false)
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
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onWheel)
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
        active ? 'is-active' : ''
      ].join(' ')}
      style={style}
      data-testid={`widget-${widget.kind ?? 'terminal'}-${widget.id}`}
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
        className="widget-header-shell flex h-[34px] flex-none cursor-grab items-center gap-1 py-0 pr-0 pl-2.5 active:cursor-grabbing"
        onPointerDown={handleHeaderPointerDown}
        onDoubleClick={isTerminal ? onTerminalDoubleClick : undefined}
      >
        {editing ? (
          <input
            className="h-[22px] min-w-0 flex-1 appearance-none bg-transparent px-1.5 text-xs text-text outline-none focus:outline-none focus:ring-0 focus-visible:outline-none"
            style={{ outline: 'none', boxShadow: 'none' }}
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
                  role="menu"
                  aria-label="Agent"
                  className="fixed z-[9800] flex min-w-[150px] flex-col overflow-hidden rounded-[10px] border border-line-soft bg-bg-panel py-1 shadow-lg"
                  style={{ left: menuPos.left, top: menuPos.top, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  // Portal bubbles through the widget tree to <main>; stopping
                  // only mousedown leaves pointerdown free to trigger the
                  // canvas draw/erase/pan gestures beneath the menu.
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {AGENTS.map((a, i) => (
                    <button
                      key={a.id}
                      role="menuitem"
                      className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors duration-150 hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60 focus:bg-bg-hover ${
                        i === agentIdx ? 'text-text' : 'text-text-dim'
                      }`}
                      onClick={() => {
                        agentSelectionByWidget.set(widget.id, i)
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
        {!editing && !isTerminal && canRename && (
          <button
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={onStartEditing}
            data-testid="widget-rename"
            title="Rename"
            aria-label="Rename"
          >
            <Pencil size={11} strokeWidth={1.5} />
          </button>
        )}
        <div className="ml-1 flex h-[34px] flex-none items-center">
          {canMaximize && (
            <button
              className="grid h-full w-8 place-items-center text-text-dim outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
              onClick={onToggleMaximize}
              data-testid="widget-maximize"
              title={widget.maximized ? 'Restore' : 'Maximize'}
              aria-label={widget.maximized ? 'Restore' : 'Maximize'}
            >
              {widget.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
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
            onTitle={onRename}
          />
        </ErrorBoundary>
      </div>
      {!widget.maximized &&
        RESIZE_HANDLES.map((dir) => (
          <div
            key={dir}
            className={`absolute z-[5] ${HANDLE_CLASS[dir]}`}
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
  onProcessExit,
  onTitle
}: {
  widget: Widget
  workspaceDir?: string | null
  onProcessExit: () => void
  onTitle?: (title: string) => void
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
      return <TerminalWidget id={widget.id} onProcessExit={onProcessExit} />
  }
}

function areWidgetFramePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.widget === next.widget &&
    prev.active === next.active &&
    prev.editing === next.editing &&
    prev.workspaceDir === next.workspaceDir &&
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

