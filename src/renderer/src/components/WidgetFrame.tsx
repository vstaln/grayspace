import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Minus, Pencil, Square, X } from 'lucide-react'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
import GrokIcon from './GrokIcon'
import AntigravityIcon from './AntigravityIcon'
import TerminalWidget from './TerminalWidget'
import NoteWidget from './NoteWidget'
import GitStatusWidget from './GitStatusWidget'
import TimerWidget from './TimerWidget'
import ScheduleWidget from './ScheduleWidget'
import PlannerWidget from './PlannerWidget'
import BoardWidget from './BoardWidget'
import { RESIZE_HANDLES, ResizeDir, Widget } from '../types'

interface Props {
  widget: Widget
  active: boolean
  editing: boolean
  style: React.CSSProperties
  onHeaderMouseDown: (e: React.MouseEvent) => void
  onResizeStart: (e: React.MouseEvent, dir: ResizeDir) => void
  onFocus: () => void
  onStartEditing: () => void
  onRename: (title: string) => void
  onCancelEditing: () => void
  onToggleMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  workspaceDir?: string | null
}

const AGENTS = [
  { id: 'antigravity', label: 'Antigravity', command: 'agy\r', Icon: AntigravityIcon },
  { id: 'claude', label: 'Claude', command: 'claude\r', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', command: 'codex\r', Icon: CodexIcon },
  { id: 'grok', label: 'Grok', command: 'grok\r', Icon: GrokIcon }
] as const

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

const WidgetFrame = React.memo(function WidgetFrame({
  widget,
  active,
  editing,
  style,
  onHeaderMouseDown,
  onResizeStart,
  onFocus,
  onStartEditing,
  onRename,
  onCancelEditing,
  onToggleMinimize,
  onToggleMaximize,
  onClose,
  onKeyDown,
  workspaceDir
}: Props): React.JSX.Element {
  const isTerminal = !widget.kind || widget.kind === 'terminal'
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [agentIdx, setAgentIdx] = useState(0)
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const agent = AGENTS[agentIdx]
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)

  const launchAgent = (): void => {
    setAgentLaunchError(null)
    void window.api.terminal
      .write(widget.id, agent.command)
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
  }, [agentMenuOpen])

  useEffect(() => {
    if (!agentMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) setAgentMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAgentMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [agentMenuOpen])

  return (
    <div
      className={[
        'widget-shell widget absolute flex flex-col overflow-hidden rounded-[10px]',
        active ? 'is-active' : ''
      ].join(' ')}
      style={style}
      onMouseDown={onFocus}
      // P3-219: the frame is a keyboard stop — arrows move it, Alt+arrows
      // resize it, Delete closes it (handled in App's onFrameKey).
      tabIndex={0}
      role="group"
      aria-label={widget.title}
      onKeyDown={onKeyDown}
    >
      <div
        className="widget-header-shell flex h-[34px] flex-none cursor-grab items-center gap-1 py-0 pr-0 pl-2.5 active:cursor-grabbing"
        onMouseDown={onHeaderMouseDown}
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
          <span className="min-w-0 flex-1 truncate text-xs text-text" onDoubleClick={onStartEditing}>
            {widget.title}
          </span>
        )}
        {isTerminal && (
          <button
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={launchAgent}
            title={`Запустить ${agent.label}`}
            aria-label={`Запустить ${agent.label}`}
          >
            <agent.Icon size={13} />
          </button>
        )}
        {isTerminal && agentLaunchError && (
          <span
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
              title="Выбрать агента"
              aria-label="Выбрать агента"
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
                  aria-label="Агент"
                  className="fixed z-[9800] flex min-w-[150px] flex-col overflow-hidden rounded-[10px] border border-line-soft bg-bg-panel py-1 shadow-lg"
                  style={{ left: menuPos.left, top: menuPos.top, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
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
        {!editing && !isTerminal && (
          <button
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={onStartEditing}
            title="Переименовать"
            aria-label="Переименовать"
          >
            <Pencil size={11} strokeWidth={1.5} />
          </button>
        )}
        <div className="ml-1 flex h-[34px] flex-none items-center">
          <button
            className="grid h-full w-8 place-items-center text-text-dim outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={onToggleMinimize}
            title={widget.minimized ? 'Развернуть' : 'Свернуть'}
            aria-label={widget.minimized ? 'Развернуть' : 'Свернуть'}
          >
            <Minus size={13} />
          </button>
          <button
            className="grid h-full w-8 place-items-center text-text-dim outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={onToggleMaximize}
            title={widget.maximized ? 'Восстановить' : 'На весь холст'}
            aria-label={widget.maximized ? 'Восстановить' : 'На весь холст'}
          >
            {widget.maximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            className="grid h-full w-8 place-items-center rounded-tr-[10px] text-text-dim outline-none transition-colors duration-150 hover:bg-[#e04343] hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className={`widget-body min-h-0 flex-1 bg-transparent ${widget.minimized ? 'hidden' : ''}`}>
        <WidgetBody widget={widget} workspaceDir={workspaceDir} onProcessExit={onClose} />
      </div>
      {!widget.minimized &&
        !widget.maximized &&
        RESIZE_HANDLES.map((dir) => (
          <div
            key={dir}
            className={`absolute z-[5] ${HANDLE_CLASS[dir]}`}
            onMouseDown={(e) => onResizeStart(e, dir)}
          />
        ))}
    </div>
  )
})

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
    case 'note':
      return widget.noteId ? (
        <NoteWidget noteId={widget.noteId} workspaceDir={workspaceDir} />
      ) : (
        <div className="grid h-full place-items-center text-[13px] text-text-faint">Заметка не привязана</div>
      )
    case 'git-status':
      return <GitStatusWidget />
    case 'timer':
      return <TimerWidget />
    case 'schedule':
      return <ScheduleWidget />
    case 'planner':
      return <PlannerWidget />
    case 'board':
      return <BoardWidget />
    default:
      return <TerminalWidget id={widget.id} onProcessExit={onProcessExit} />
  }
}

export default WidgetFrame
