import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, Pencil, Terminal, X } from 'lucide-react'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import OpenCodeIcon from './OpenCodeIcon'
import CursorIcon from './CursorIcon'
import TerminalWidget from './TerminalWidget'
import TimerWidget from './TimerWidget'
import PlannerWidget from './PlannerWidget'
import OrchestrationWidget from './OrchestrationWidget'
import FilesWidget from './FilesWidget'
import SysMonitorWidget from './SysMonitorWidget'
import BrowserWidget from './BrowserWidget'
import LinksWidget from './LinksWidget'
import MusicPlayerWidget from './MusicPlayerWidget'
import MissionWidget from './MissionWidget'
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
  { id: 'grok', label: 'Grok', command: 'grok', Icon: GrokIcon },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', Icon: Terminal },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', Icon: CursorIcon },
  { id: 'aider', label: 'Aider', command: 'aider', Icon: Terminal }
] as const





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





  const canRename = isTerminal
  const canMaximize = !NON_MAXIMIZABLE.has((widget.kind ?? 'terminal') as WidgetKind)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [agentIdx, setAgentIdx] = useState(() => agentSelectionByWidget.get(widget.id) ?? 0)
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const agentPanelRef = useRef<HTMLDivElement>(null)
  const agent = AGENTS[agentIdx]
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)


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



  useEffect(() => {
    if (!agentMenuOpen) return
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
    case 'mission':
      return <MissionWidget widgetId={widget.id} />
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

