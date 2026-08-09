import React, { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, Plus } from 'lucide-react'
import type { CoordinationSnapshot, Task } from '../../../preload/index.d'

const DAY = 24 * 60 * 60 * 1000

/**
 * Everything with a deadline, soonest first.
 *
 * It is a view of the kanban board rather than a store of its own: a task with
 * a date is the same task the board shows and an agent can claim, and keeping
 * a second list of "scheduled things" would mean two places to look and two
 * places to forget. Adding here just creates a board task with a due date.
 */
export default function ScheduleWidget(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot>({ managerId: null, tasks: [], locks: [] })
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.coordination.status().then(setSnapshot)
    return window.api.coordination.onChange(setSnapshot)
  }, [])

  const planned = useMemo(
    () =>
      snapshot.tasks
        .filter((task) => task.dueAt && task.state !== 'done' && task.state !== 'cancelled')
        .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0)),
    [snapshot.tasks]
  )

  const add = async (): Promise<void> => {
    const text = title.trim()
    if (!text) return
    const result = await window.api.coordination.createTask({
      title: text,
      // No date is a perfectly good plan for "soon"; it just sorts last.
      dueAt: due ? Date.parse(due) : undefined
    })
    if (result && typeof result === 'object' && 'error' in result) {
      setError((result as { error: string }).error)
      return
    }
    setError(null)
    setTitle('')
    setDue('')
  }

  const complete = (task: Task): void => {
    void window.api.coordination.updateTask(task.id, { state: 'done' })
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-none gap-1.5">
        <input
          className="min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2.5 py-1.5 text-[12px] text-text outline-none placeholder:text-text-faint focus:border-text-faint"
          placeholder="Что нужно сделать"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <input
          type="date"
          className="flex-none rounded-[10px] border border-line bg-bg px-2 py-1.5 text-[12px] text-text-dim outline-none focus:border-text-faint"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <button
          className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[10px] bg-accent text-black disabled:opacity-40 hover:bg-white"
          disabled={!title.trim()}
          title="Добавить"
          onClick={() => void add()}
        >
          <Plus size={14} />
        </button>
      </div>

      {error && <p className="flex-none text-[11px] text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {planned.length === 0 ? (
          <p className="pt-6 text-center text-[12px] text-text-faint">
            Ничего не запланировано. Задачи с датой из доски появятся здесь.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {planned.map((task) => (
              <li
                key={task.id}
                className="group flex items-center gap-2 rounded-[10px] border border-line-soft px-2.5 py-1.5"
              >
                <button
                  className="grid h-5 w-5 flex-none place-items-center rounded-full border border-line text-transparent hover:border-ok hover:text-ok"
                  title="Отметить выполненной"
                  onClick={() => complete(task)}
                >
                  <Check size={11} />
                </button>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text">{task.title}</span>
                <DueChip at={task.dueAt as number} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Colour carries the urgency; the text stays plain so it reads at a glance. */
function DueChip({ at }: { at: number }): React.JSX.Element {
  const left = at - Date.now()
  const overdue = left < 0
  const soon = !overdue && left < DAY
  return (
    <span
      className={`flex flex-none items-center gap-1 text-[11px] ${
        overdue ? 'text-danger' : soon ? 'text-[#f59e0b]' : 'text-text-faint'
      }`}
      title={new Date(at).toLocaleString('ru')}
    >
      <CalendarClock size={11} />
      {relative(left)}
    </span>
  )
}

function relative(ms: number): string {
  const days = Math.round(ms / DAY)
  if (ms < 0) return days === 0 ? 'сегодня' : `просрочено на ${Math.abs(days)} д`
  if (days === 0) return 'сегодня'
  if (days === 1) return 'завтра'
  return `через ${days} д`
}
