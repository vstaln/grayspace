import React, { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CoordinationSnapshot, Task, TaskState } from '../../../preload/index.d'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useConfirm } from './ConfirmDialog'
import { frost, lanes, palette } from '../design'

interface Props {
  snapshot: CoordinationSnapshot
  onCreate: (title: string, brief?: string) => Promise<{ ok: boolean; error?: string }>
  onMove: (id: string, state: TaskState) => Promise<{ ok: boolean; error?: string }>
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
  onResetManager: () => Promise<{ ok: boolean; error?: string }>
  onReleaseLocks: () => Promise<{ ok: boolean; error?: string }>
  onClose: () => void
  /**
   * Rendered inside a canvas widget rather than as a modal over it. The board
   * is a thing you keep beside your terminals, not a dialog you dismiss — so
   * embedded it drops the fixed framing, the focus trap and the close button,
   * and the widget frame supplies all three.
   */
  embedded?: boolean
}

const COLUMNS: { state: TaskState; states: TaskState[]; label: string; tone: 'blue' | 'amber' | 'green' | 'red' }[] = [
  { state: 'backlog', states: ['backlog', 'queued'], label: 'To Do', tone: 'blue' },
  { state: 'in_progress', states: ['in_progress', 'review'], label: 'In Progress', tone: 'amber' },
  { state: 'done', states: ['done'], label: 'Complete', tone: 'green' },
  { state: 'cancelled', states: ['cancelled'], label: 'Cancelled', tone: 'red' }
]

/** Left border tints match design/tokens `lanes` dots, not generic Tailwind blues. */
const TONE_BORDER: Record<'blue' | 'amber' | 'green' | 'red', string> = {
  blue: lanes.blue.dot,
  amber: lanes.amber.dot,
  green: lanes.green.dot,
  red: lanes.red.dot
}

export default function KanbanBoard({
  snapshot,
  onCreate,
  onMove,
  onDelete,
  onResetManager: _onResetManager,
  onReleaseLocks: _onReleaseLocks,
  onClose,
  embedded = false
}: Props): React.JSX.Element {
  const [optimisticOverrides, setOptimisticOverrides] = useState<Record<string, TaskState>>({})
  const [title, setTitle] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<TaskState | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const confirm = useConfirm()

  useFocusTrap(panelRef, !embedded)

  const effectiveTasks = React.useMemo(() => {
    return (snapshot?.tasks || []).map((t) => {
      const override = optimisticOverrides[t.id]
      if (override && override !== t.state) return { ...t, state: override }
      return t
    })
  }, [snapshot?.tasks, optimisticOverrides])

  const run = async (id: string | null, action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    if (id && busyIds.has(id)) return
    if (!id && creating) return
    if (id) setBusyIds((cur) => new Set(cur).add(id))
    else setCreating(true)
    try {
      const result = await action()
      if (!result.ok) {
        if (id) {
          setOptimisticOverrides((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        }
        setError(result.error ?? 'Action failed')
      } else {
        // Keep the optimistic override: the authoritative snapshot lands via the
        // coordination broadcast, and deleting the override here — before that
        // broadcast reaches this frame — makes the card snap back to the
        // pre-drag column for a tick. The memo prunes it once the snapshot
        // catches up with the moved state.
        setError(null)
      }
    } catch (err) {
      if (id) {
        setOptimisticOverrides((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id) setBusyIds((cur) => {
        const next = new Set(cur)
        next.delete(id)
        return next
      })
      else setCreating(false)
    }
  }

  const submit = (): void => {
    const value = title.trim()
    if (!value || creating) return
    const submitted = value
    void run(null, () => onCreate(submitted).then((r) => {
      if (r.ok) setTitle('')
      return r
    }))
  }

  const drop = (state: TaskState): void => {
    if (dragId) {
      const task = effectiveTasks.find((t) => t.id === dragId)
      const column = COLUMNS.find((c) => c.states.includes(state))
      // A busy task's move is already in flight: run() would reject a second
      // one, and an override applied here would stick in the wrong column.
      if (task && column && !busyIds.has(task.id) && !column.states.includes(task.state)) {
        setOptimisticOverrides((prev) => ({ ...prev, [task.id]: state }))
        void run(task.id, () => onMove(task.id, state))
      }
    }
    setDragId(null)
    setOverColumn(null)
  }

  const cancelDrag = (): void => {
    setDragId(null)
    setOverColumn(null)
  }

  const totalTasks = effectiveTasks.length
  const doneTasks = effectiveTasks.filter((t) => t.state === 'done').length

  return (
    <section
      ref={panelRef}
      role={embedded ? 'group' : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-label="Task Board"
      data-testid="board-panel"
      className={
        embedded
          ? 'board-shell flex h-full flex-col overflow-hidden'
          : 'board-shell pop-in fixed inset-[76px_7%_42px] z-[12000] mx-auto flex w-auto min-w-0 max-w-[min(100%,1400px)] flex-col overflow-hidden rounded-[10px] border border-line-soft shadow-[0_28px_80px_rgba(0,0,0,0.7)] sm:min-w-[min(100%,760px)]'
      }
      style={{ background: palette.graphite, backdropFilter: frost.board, WebkitBackdropFilter: frost.board }}
    >
      <header className="flex min-h-[46px] items-center justify-between gap-3 border-b border-line-soft px-4">
        <h2 className="min-w-0 truncate text-[14px] font-medium text-text">Task Board</h2>
        <div className="flex flex-none items-center gap-3">
          <div className="text-[12px] text-text-dim tabular-nums">
            {doneTasks} <span className="text-text-faint">/ {totalTasks}</span>
          </div>
          <button
            className={`grid h-7 w-7 place-items-center rounded-[10px] text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text ${embedded ? 'hidden' : ''}`}
            onClick={onClose}
            title="Close"
            aria-label="Close Task Board"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div className="border-b border-line-soft px-4 py-3">
        <input
          ref={titleInputRef}
          className="w-full rounded-[10px] border border-transparent bg-bg-hover/40 px-3 py-2 text-[13px] text-text outline-none transition-colors duration-150 placeholder:text-text-faint focus:border-line-soft focus:bg-bg-hover/60"
          placeholder="New task… (Enter to create)"
          value={title}
          disabled={creating}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          aria-label="New task"
          data-testid="board-task-input"
        />
      </div>

      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((column) => {
          const tasks = effectiveTasks.filter((t) => column.states.includes(t.state))
          return (
            <div
              key={column.state}
              className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden rounded-[10px] transition-colors duration-200 ${
                overColumn === column.state ? 'bg-bg-hover/40' : ''
              }`}
              onDragOver={(e) => {
                e.preventDefault()
                setOverColumn(column.state)
              }}
              onDragLeave={(e) => {
                const next = e.relatedTarget as Node | null
                if (next && e.currentTarget.contains(next)) return
                setOverColumn((c) => (c === column.state ? null : c))
              }}
              onDrop={() => drop(column.state)}
            >
              <div className="flex min-h-[48px] items-center justify-between gap-2 px-2 pt-1 pb-3 text-[13px] font-medium">
                <span className="flex min-w-0 items-center gap-2 truncate text-text">
                  <i className={`lane-dot-${column.tone} h-[8px] w-[8px] flex-none rounded-full`} aria-hidden />
                  {column.label}
                </span>
                <span className="flex-none text-[11px] text-text-faint tabular-nums">{tasks.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto pb-4">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    tone={column.tone}
                    busy={busyIds.has(task.id)}
                    onDragStart={() => setDragId(task.id)}
                    onDragEnd={cancelDrag}
                    onMove={(state) => void run(task.id, () => onMove(task.id, state))}
                    onDelete={() => {
                      void confirm(`Delete task “${task.title}”?`, {
                        danger: true,
                        title: 'Delete task',
                        confirmLabel: 'Delete'
                      }).then((ok) => {
                        if (ok) void run(task.id, () => onDelete(task.id))
                      })
                    }}
                  />
                ))}
                {tasks.length === 0 && (
                  <div className="m-auto text-[12px] text-text-faint">Empty</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TaskCard({
  task,
  tone,
  busy,
  onDragStart,
  onDragEnd,
  onMove,
  onDelete
}: {
  task: Task
  tone: 'blue' | 'amber' | 'green' | 'red'
  busy: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (state: TaskState) => void
  onDelete: () => void
}): React.JSX.Element {
  const moveBy = (delta: number): void => {
    if (busy) return
    const index = COLUMNS.findIndex((c) => c.states.includes(task.state))
    const target = COLUMNS[Math.min(COLUMNS.length - 1, Math.max(0, index + delta))]
    if (target && !target.states.includes(task.state)) onMove(target.state)
  }

  return (
    <article
      className={`group relative flex flex-col gap-1.5 rounded-[10px] border border-line-soft border-l-[3px] bg-bg-hover/50 p-3 outline-none transition-colors duration-200 hover:border-line focus-visible:ring-1 focus-visible:ring-line active:cursor-grabbing ${busy ? 'cursor-wait opacity-60' : 'cursor-grab'}`}
      style={{ borderLeftColor: TONE_BORDER[tone] }}
      draggable={!busy}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      tabIndex={0}
      title="Alt+←/→ — move between columns"
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault()
        moveBy(e.key === 'ArrowLeft' ? -1 : 1)
      }}
    >
      {/* The shortcut lives only in the hover tooltip; keyboard users need it too. */}
      <span className="sr-only">Press Alt with Left or Right arrow to move this task between columns</span>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 pr-5 text-[12.5px] leading-snug break-words text-text">{task.title}</span>
        <button
          className="absolute top-2.5 right-2 flex h-5 w-5 items-center justify-center rounded-[10px] bg-transparent text-text-dim opacity-0 transition-all duration-150 hover:bg-danger hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          disabled={busy}
          onClick={onDelete}
          title="Delete"
          aria-label="Delete task"
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>
      {task.brief && (
        <p className="line-clamp-3 text-[11px] leading-relaxed break-words text-text-faint">{task.brief}</p>
      )}
      <div className="mt-1 flex flex-wrap gap-1.5">
        <span
          className={`max-w-full truncate rounded-full px-2 py-0.5 text-[10px] ${
            task.createdBy === 'user' ? 'bg-bg-hover text-text' : 'bg-bg-hover/60 text-text-dim'
          }`}
        >
          {task.createdBy === 'user' ? 'you' : task.createdBy}
        </span>
        {task.assignee && (
          <span className="max-w-full truncate rounded-full bg-ok/15 px-2 py-0.5 text-[10px] text-ok">
            {task.assignee}
          </span>
        )}
      </div>
    </article>
  )
}
