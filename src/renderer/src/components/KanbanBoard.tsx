import React, { useEffect, useRef, useState } from 'react'
import { Bot, Layers, User, X } from 'lucide-react'
import type { CoordinationSnapshot, Task, TaskState } from '../../../preload/index.d'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useConfirm } from './ConfirmDialog'
import { lanes, palette } from '../design'

interface Props {
  snapshot: CoordinationSnapshot
  onCreate?: (title: string, brief?: string) => Promise<{ ok: boolean; error?: string }>
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

const COLUMNS: { state: TaskState; states: TaskState[]; label: string; tone: 'blue' | 'amber' | 'green' | 'red'; emptyText: string }[] = [
  { state: 'backlog', states: ['backlog', 'queued'], label: 'To Do', tone: 'blue', emptyText: 'No pending tasks · Add in Planner' },
  { state: 'in_progress', states: ['in_progress', 'review'], label: 'In Progress', tone: 'amber', emptyText: 'No active tasks' },
  { state: 'done', states: ['done'], label: 'Complete', tone: 'green', emptyText: 'No completed tasks' },
  { state: 'cancelled', states: ['cancelled'], label: 'Cancelled', tone: 'red', emptyText: 'No cancelled tasks' }
]

/** Left border tints match design/tokens `lanes` dots, not generic Tailwind blues. */
const TONE_BORDER: Record<'blue' | 'amber' | 'green' | 'red', string> = {
  blue: lanes.blue.dot,
  amber: lanes.amber.dot,
  green: lanes.green.dot,
  red: lanes.red.dot
}

const KNOWN_AGENTS = new Set(['claude', 'codex', 'cursor', 'opencode', 'gemini', 'antigravity', 'grok'])

export default function KanbanBoard({
  snapshot,
  onCreate,
  onMove,
  onDelete,
  onResetManager,
  onReleaseLocks,
  onClose,
  embedded = false
}: Props): React.JSX.Element {
  const [optimisticOverrides, setOptimisticOverrides] = useState<Record<string, TaskState>>({})
  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<TaskState | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  // Serializes the header's maintenance actions (reset lead / release locks):
  // both mutate shared coordination state, so they must not overlap.
  const [maintenanceBusy, setMaintenanceBusy] = useState<'manager' | 'locks' | null>(null)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const busyIdsRef = useRef<Set<string>>(new Set())
  const maintenanceBusyRef = useRef(false)
  const creatingRef = useRef(false)
  const aliveRef = useRef(true)
  const confirm = useConfirm()

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useFocusTrap(panelRef, !embedded)

  const maintenance = async (kind: 'manager' | 'locks'): Promise<void> => {
    if (maintenanceBusyRef.current) return
    maintenanceBusyRef.current = true
    setMaintenanceBusy(kind)
    try {
      const result = kind === 'manager' ? await onResetManager() : await onReleaseLocks()
      if (!aliveRef.current) return
      if (!result.ok) {
        setError(result.error ?? (kind === 'manager' ? 'Manager reset failed' : 'Failed to release locks'))
      } else {
        setError(null)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      maintenanceBusyRef.current = false
      if (aliveRef.current) setMaintenanceBusy(null)
    }
  }

  const createTask = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const title = newTaskTitle.trim()
    if (!onCreate || !title || creating || creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    try {
      const result = await onCreate(title)
      if (!aliveRef.current) return
      if (!result.ok) setError(result.error ?? 'Task creation failed')
      else {
        setNewTaskTitle('')
        setError(null)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      creatingRef.current = false
      if (aliveRef.current) setCreating(false)
    }
  }

  const effectiveTasks = React.useMemo(() => {
    return (snapshot?.tasks || []).map((t) => {
      const override = optimisticOverrides[t.id]
      if (override && override !== t.state) return { ...t, state: override }
      return t
    })
  }, [snapshot?.tasks, optimisticOverrides])

  // Once the authoritative snapshot agrees with an override — or the task is
  // gone entirely — drop it.
  useEffect(() => {
    setOptimisticOverrides((prev) => {
      const tasks = snapshot?.tasks ?? []
      const live = new Set(tasks.map((t) => t.id))
      let changed = false
      const next = { ...prev }
      for (const id of Object.keys(prev)) {
        if (!live.has(id) || prev[id] === tasks.find((t) => t.id === id)?.state) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [snapshot])

  const run = async (id: string, action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    if (busyIdsRef.current.has(id)) return
    busyIdsRef.current.add(id)
    setBusyIds((cur) => new Set(cur).add(id))
    try {
      const result = await action()
      if (!aliveRef.current) return
      if (!result.ok) {
        setOptimisticOverrides((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        setError(result.error ?? 'Action failed')
      } else {
        setError(null)
      }
    } catch (err) {
      if (!aliveRef.current) return
      setOptimisticOverrides((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      busyIdsRef.current.delete(id)
      if (aliveRef.current) {
        setBusyIds((cur) => {
          const next = new Set(cur)
          next.delete(id)
          return next
        })
      }
    }
  }

  const drop = (state: TaskState): void => {
    if (dragId) {
      const task = effectiveTasks.find((t) => t.id === dragId)
      const column = COLUMNS.find((c) => c.states.includes(state))
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
  const inProgressTasks = effectiveTasks.filter((t) => t.state === 'in_progress' || t.state === 'review').length
  const hasPending = busyIds.size > 0 || maintenanceBusy !== null || creating

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
          : 'board-shell pop-in fixed inset-[76px_7%_42px] z-[12000] mx-auto flex w-auto min-w-0 max-w-[min(100%,1400px)] flex-col overflow-hidden rounded-[10px] border border-line-soft shadow-[0_28px_80px_rgba(8,9,11,0.7)] sm:min-w-[min(100%,760px)]'
      }
      style={{ background: palette.graphite }}
    >
      <header className="flex min-h-[46px] flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Layers size={15} className="flex-none text-accent" />
          <h2 className="min-w-0 truncate text-[14px] font-medium text-text">Task Board</h2>
          <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent border border-accent/20">
            <span className={`h-1.5 w-1.5 rounded-full bg-accent ${hasPending ? 'animate-pulse' : ''}`} />
            Synced with Planner
          </span>
        </div>
        <div className="flex min-w-0 flex-none flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 text-[12px] text-text-dim tabular-nums">
            {inProgressTasks > 0 && (
              <span className="mr-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400 font-medium">
                {inProgressTasks} active
              </span>
            )}
            <span>{doneTasks}</span>
            <span className="text-text-faint">/ {totalTasks}</span>
          </div>
          {snapshot?.managerId && (
            <button
              className="hidden min-[420px]:inline-flex items-center rounded-[8px] border border-line-soft px-2 py-1 text-[11px] text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text disabled:opacity-40"
              disabled={maintenanceBusy !== null}
              onClick={() => void maintenance('manager')}
              title="Clear the current lead so any agent can claim the role again"
            >
              Reset Lead
            </button>
          )}
          <button
            className="hidden min-[420px]:inline-flex items-center rounded-[8px] border border-line-soft px-2 py-1 text-[11px] text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text disabled:opacity-40"
            disabled={maintenanceBusy !== null}
            onClick={() => void maintenance('locks')}
            title="Force-release every file lock"
          >
            Release Locks
          </button>
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

      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger">{error}</div>
      )}

      {onCreate && (
        <form onSubmit={(event) => void createTask(event)} className="flex flex-none items-center gap-2 border-b border-line-soft px-4 py-2">
          <input
            data-testid="board-task-input"
            value={newTaskTitle}
            onChange={(event) => setNewTaskTitle(event.target.value)}
            placeholder="Add a task…"
            aria-label="New task title"
            disabled={creating}
            maxLength={200}
            className="h-8 min-w-0 flex-1 rounded-[8px] border border-line-soft bg-bg-raise px-2.5 text-[12px] text-text outline-none placeholder:text-text-faint focus:border-accent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={creating || !newTaskTitle.trim()}
            className="flex h-8 items-center gap-1.5 rounded-[8px] bg-accent px-3 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {creating && <span className="h-3 w-3 animate-spin rounded-full border border-bg/40 border-t-bg" aria-hidden />}
            {creating ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}

      <div className="@container grid min-h-0 flex-1 grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4 overflow-auto p-4">
        {COLUMNS.map((column) => {
          const tasks = effectiveTasks.filter((t) => column.states.includes(t.state))
          return (
            <div
              key={column.state}
              className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] transition-colors duration-200 ${
                overColumn === column.state ? 'bg-bg-hover/40 ring-1 ring-accent/30' : ''
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
              <div className="flex min-h-[44px] items-center justify-between gap-2 px-2 pt-1 pb-2 text-[13px] font-medium">
                <span className="flex min-w-0 items-center gap-2 truncate text-text">
                  <i className={`lane-dot-${column.tone} h-[8px] w-[8px] flex-none rounded-full`} aria-hidden />
                  {column.label}
                </span>
                <span className="flex-none rounded-full bg-bg-hover/60 px-1.5 py-0.5 text-[10px] text-text-dim tabular-nums font-mono">
                  {tasks.length}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto pb-4 px-1">
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
                  <div className="m-auto flex flex-col items-center justify-center py-8 text-center text-[11px] text-text-faint">
                    <span>{column.emptyText}</span>
                  </div>
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

  const isAgent = Boolean(task.assignee && (KNOWN_AGENTS.has(task.assignee.toLowerCase()) || task.assignee.startsWith('agent-') || task.assignee.startsWith('term-')))

  return (
    <article
      className={`group relative flex flex-col gap-1.5 rounded-[10px] border border-line-soft border-l-[3px] bg-bg-hover/50 p-3 outline-none transition-all duration-200 hover:border-line hover:bg-bg-hover/70 focus-visible:ring-1 focus-visible:ring-line active:cursor-grabbing ${busy ? 'cursor-wait opacity-60' : 'cursor-grab'}`}
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
      <span className="sr-only">Press Alt with Left or Right arrow to move this task between columns</span>
      <div className="flex items-start justify-between gap-2">
        <span className={`min-w-0 flex-1 pr-5 text-[12.5px] leading-snug break-words ${task.state === 'done' ? 'text-text-faint line-through' : 'text-text font-normal'}`}>
          {task.title}
        </span>
        <button
          className="absolute top-2.5 right-2 flex h-5 w-5 items-center justify-center rounded-[8px] bg-transparent text-text-dim opacity-0 transition-all duration-150 hover:bg-bg-hover hover:text-text group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
          disabled={busy}
          onClick={onDelete}
          title="Delete"
          aria-label="Delete task"
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>

      {task.brief && (
        <p className="line-clamp-2 text-[11px] leading-relaxed break-words text-text-faint">{task.brief}</p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {task.tags && task.tags.length > 0 && task.tags.map((tag, tagIdx) => (
          <span key={`${tag}-${tagIdx}`} className="max-w-[140px] truncate rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent border border-accent/20">
            {tag}
          </span>
        ))}

        {task.assignee ? (
          <span
            className={`inline-flex items-center gap-1 max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-medium ${
              isAgent
                ? 'bg-bg-hover text-text border border-line'
                : 'bg-ok/15 text-ok border border-ok/30'
            }`}
            title={`Assigned to ${task.assignee}`}
          >
            {isAgent ? <Bot size={10} /> : <User size={10} />}
            <span className="truncate">{task.assignee}</span>
          </span>
        ) : (
          <span
            className={`max-w-full truncate rounded-full px-2 py-0.5 text-[10px] ${
              task.createdBy === 'user' ? 'bg-bg-hover/60 text-text-faint' : 'bg-bg-hover/60 text-text-dim'
            }`}
          >
            {task.createdBy === 'user' ? 'you' : task.createdBy}
          </span>
        )}
      </div>
    </article>
  )
}
