import React, { useState } from 'react'
import { Minus, Pencil, X } from 'lucide-react'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
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
  onClose: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  workspaceDir?: string | null
}

const AGENTS = [
  { id: 'claude', label: 'Claude', command: 'claude\r', Icon: ClaudeIcon },
  { id: 'codex', label: 'Codex', command: 'codex\r', Icon: CodexIcon }
] as const

/** Absolute positioning + cursor per edge/corner of the resizable frame. */
const HANDLE_CLASS: Record<ResizeDir, string> = {
  n: 'top-[-2px] right-2 left-2 h-1.5 cursor-ns-resize',
  s: 'bottom-[-2px] right-2 left-2 h-1.5 cursor-ns-resize',
  e: 'top-2 right-[-2px] bottom-2 w-1.5 cursor-ew-resize',
  w: 'top-2 bottom-2 left-[-2px] w-1.5 cursor-ew-resize',
  ne: 'top-[-3px] right-[-3px] h-[13px] w-[13px] cursor-nesw-resize',
  nw: 'top-[-3px] left-[-3px] h-[13px] w-[13px] cursor-nwse-resize',
  se: 'right-[-3px] bottom-[-3px] h-[13px] w-[13px] cursor-nwse-resize',
  sw: 'bottom-[-3px] left-[-3px] h-[13px] w-[13px] cursor-nesw-resize'
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
  onClose,
  onKeyDown,
  workspaceDir
}: Props): React.JSX.Element {
  const isTerminal = !widget.kind || widget.kind === 'terminal'
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [agentIdx, setAgentIdx] = useState(0)
  const agent = AGENTS[agentIdx]
  return (
    <div
      className={[
        'widget-shell widget absolute flex flex-col overflow-hidden rounded-[10px] border border-line',
        active ? 'widget-shell is-active border-white/55' : ''
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
        className="widget-header-shell flex h-[34px] flex-none cursor-grab items-center gap-1 border-b border-line-soft py-0 pr-0 pl-2.5 active:cursor-grabbing"
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
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:outline-none"
            onClick={() => window.api.terminal.write(widget.id, agent.command)}
            title={`Запустить ${agent.label}`}
            aria-label={`Запустить ${agent.label}`}
          >
            <agent.Icon size={13} />
          </button>
        )}
        {isTerminal && (
          <div className="relative">
            <button
              className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:outline-none"
              onClick={() => setAgentMenuOpen((v) => !v)}
              title="Выбрать агента"
              aria-label="Выбрать агента"
            >
              <Pencil size={11} strokeWidth={1.5} />
            </button>
            {agentMenuOpen && (
              <div
                className="absolute top-full right-0 z-[1100] mt-1 flex flex-col overflow-hidden rounded-[10px] border border-line-soft bg-bg-panel py-1 shadow-lg"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {AGENTS.map((a, i) => (
                  <button
                    key={a.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text outline-none hover:bg-bg-hover focus:outline-none focus-visible:outline-none"
                    onClick={() => {
                      setAgentIdx(i)
                      setAgentMenuOpen(false)
                    }}
                  >
                    <a.Icon size={13} />
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!editing && !isTerminal && (
          <button
            className="grid h-6 w-6 place-items-center rounded-[10px] text-text-faint outline-none hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:outline-none"
            onClick={onStartEditing}
            title="Переименовать"
            aria-label="Переименовать"
          >
            <Pencil size={11} strokeWidth={1.5} />
          </button>
        )}
        <div className="ml-1 flex h-[34px] flex-none items-center">
          <button
            className="grid h-full w-8 place-items-center text-text-dim outline-none transition-colors hover:bg-bg-hover hover:text-text focus:outline-none focus-visible:outline-none"
            onClick={onToggleMinimize}
            title={widget.minimized ? 'Развернуть' : 'Свернуть'}
            aria-label={widget.minimized ? 'Развернуть' : 'Свернуть'}
          >
            <Minus size={13} />
          </button>
          <button
            className="grid h-full w-8 place-items-center rounded-tr-[10px] text-text-dim outline-none transition-colors hover:bg-[#e04343] hover:text-white focus:outline-none focus-visible:outline-none"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className={`widget-body min-h-0 flex-1 bg-transparent ${widget.minimized ? 'hidden' : ''}`}>
        <WidgetBody widget={widget} workspaceDir={workspaceDir} />
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
  workspaceDir
}: {
  widget: Widget
  workspaceDir?: string | null
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
      return <TerminalWidget id={widget.id} />
  }
}

export default WidgetFrame
