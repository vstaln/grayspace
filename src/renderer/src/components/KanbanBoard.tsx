import React, { useRef, useState } from 'react'
import type { CoordinationSnapshot, Task, TaskState } from '../../../preload/index.d'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  snapshot: CoordinationSnapshot
  onCreate: (title: string, brief?: string) => void
  onMove: (id: string, state: TaskState) => void
  onDelete: (id: string) => void
  onResetManager: () => void
  onReleaseLocks: () => void
  onClose: () => void
}

const COLUMNS: { state: TaskState; states: TaskState[]; label: string; tone: 'blue' | 'amber' | 'green' | 'red' }[] = [
  { state: 'backlog', states: ['backlog', 'queued'], label: 'To Do', tone: 'blue' },
  { state: 'in_progress', states: ['in_progress', 'review'], label: 'In Progress', tone: 'amber' },
  { state: 'done', states: ['done'], label: 'Complete', tone: 'green' },
  { state: 'cancelled', states: ['cancelled'], label: 'Cancelled', tone: 'red' }
]

const TONE_COLORS = {
  blue: 'border-l-[#3b82f6]',
  amber: 'border-l-[#f59e0b]',
  green: 'border-l-[#10b981]',
  red: 'border-l-[#ef4444]'
}

export default function KanbanBoard({
  snapshot,
  onCreate,
  onMove,
  onDelete,
  onResetManager,
  onReleaseLocks,
  onClose
}: Props): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overColumn, setOverColumn] = useState<TaskState | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  useFocusTrap(panelRef, true)

  const submit = (): void => {
    const value = title.trim()
    if (!value) return
    onCreate(value)
    setTitle('')
  }

  const drop = (state: TaskState): void => {
    if (dragId) onMove(dragId, state)
    setDragId(null)
    setOverColumn(null)
  }

  const totalTasks = snapshot.tasks.length
  const doneTasks = snapshot.tasks.filter((t) => t.state === 'done').length

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Доска задач"
      className="board-shell fixed z-[620] inset-[76px_7%_42px] w-auto min-w-[760px] overflow-hidden rounded-[10px] border border-line-soft bg-[rgba(18,18,20,0.6)] backdrop-blur-[28px] shadow-[0_28px_80px_rgba(0,0,0,0.7)] animate-in fade-in zoom-in-95 duration-200 flex flex-col"
    >
      <header className="flex min-h-[46px] items-center justify-between gap-3 border-b border-line-soft px-4">
        <h2 className="text-[14px] font-medium text-text">Доска задач</h2>
        <div className="flex items-center gap-3">
          <div className="text-[12px] text-text-dim">
            {doneTasks} <span className="text-text-faint">/ {totalTasks}</span>
          </div>
          <button
            className="grid h-7 w-7 place-items-center rounded-[10px] border-0 text-xl leading-none text-text-dim hover:bg-white/[0.06] hover:text-text transition-colors"
            onClick={onClose}
            title="Закрыть"
          >
            ×
          </button>
        </div>
      </header>

      <div className="border-b border-line-soft px-4 py-3">
        <input
          ref={titleInputRef}
          className="w-full rounded-[10px] border border-transparent bg-white/[0.02] px-3 py-2 text-[13px] text-text outline-none focus:border-line-soft focus:bg-white/[0.04] transition-colors placeholder:text-text-faint"
          placeholder="Новая задача… (Enter — создать)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto p-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((column) => {
          const tasks = snapshot.tasks.filter((t) => column.states.includes(t.state))
          return (
            <div
              key={column.state}
              className={`flex min-h-0 flex-col overflow-hidden rounded-[10px] transition-colors duration-200 ${
                overColumn === column.state ? 'bg-white/[0.02]' : ''
              }`}
              onDragOver={(e) => {
                e.preventDefault()
                setOverColumn(column.state)
              }}
              onDragLeave={() => setOverColumn((c) => (c === column.state ? null : c))}
              onDrop={() => drop(column.state)}
            >
              <div className="flex min-h-[48px] items-center justify-between px-2 pt-1 pb-3 text-[13px] font-medium">
                <span className="flex items-center gap-2 text-text">
                  <i className={`lane-dot-${column.tone} h-[8px] w-[8px] rounded-full`} />
                  {column.label}
                </span>
                <span className="text-[11px] text-text-faint">
                  {tasks.length}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto pb-4">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    tone={column.tone}
                    onDragStart={() => setDragId(task.id)}
                    onMove={(state) => onMove(task.id, state)}
                    onDelete={() => onDelete(task.id)}
                  />
                ))}
                {tasks.length === 0 && (
                  <div className="m-auto text-[12px] text-text-faint opacity-50">Пусто</div>
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
  onDragStart,
  onMove,
  onDelete
}: {
  task: Task
  tone: 'blue' | 'amber' | 'green' | 'red'
  onDragStart: () => void
  onMove: (state: TaskState) => void
  onDelete: () => void
}): React.JSX.Element {
  const moveBy = (delta: number): void => {
    const index = COLUMNS.findIndex((c) => c.states.includes(task.state))
    const target = COLUMNS[Math.min(COLUMNS.length - 1, Math.max(0, index + delta))]
    if (target && !target.states.includes(task.state)) onMove(target.state)
  }
  
  return (
    <article
      className={`group relative flex flex-col gap-1.5 cursor-grab rounded-[10px] bg-white/[0.03] border border-line-soft border-l-[3px] ${TONE_COLORS[tone]} p-3 hover:border-line active:cursor-grabbing transition-all duration-200 outline-none focus-visible:ring-1 focus-visible:ring-line`}
      draggable
      onDragStart={onDragStart}
      tabIndex={0}
      title="Alt+←/→ — переместить между колонками"
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault()
        moveBy(e.key === 'ArrowLeft' ? -1 : 1)
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] leading-snug text-text pr-4">{task.title}</span>
        <button 
          className="absolute top-2.5 right-2 flex h-5 w-5 items-center justify-center rounded-md border-0 bg-transparent text-[14px] leading-none text-text-dim opacity-0 transition-opacity hover:bg-danger hover:text-white group-hover:opacity-100" 
          onClick={onDelete} 
          title="Удалить" 
          aria-label="Delete task"
        >
          ×
        </button>
      </div>
      {task.brief && <p className="text-[11px] leading-relaxed text-text-faint">{task.brief}</p>}
      <div className="mt-1 flex flex-wrap gap-1.5">
        <span
          className={`max-w-full truncate rounded-full px-2 py-0.5 text-[10px] ${
            task.createdBy === 'user' ? 'bg-white/[0.08] text-text' : 'bg-white/[0.04] text-text-dim'
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
