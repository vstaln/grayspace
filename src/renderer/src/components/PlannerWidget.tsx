import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react'
import type { PlanItem } from '../../../preload/index.d'

/** Local calendar day as `YYYY-MM-DD`. */
function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return todayKey(date)
}

function formatDayLabel(key: string): string {
  const today = todayKey()
  if (key === today) return 'Сегодня'
  if (key === shiftDay(today, 1)) return 'Завтра'
  if (key === shiftDay(today, -1)) return 'Вчера'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('ru', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

/**
 * Personal day outline — not the board schedule.
 *
 * ScheduleWidget is a view of kanban tasks with due dates. This is a separate
 * hand-ordered list the human (or a manager agent) fills for a day: morning
 * errands, focus blocks, things that never become delegated work. Checking one
 * off does not move a board card.
 */
export default function PlannerWidget(): React.JSX.Element {
  const [items, setItems] = useState<PlanItem[]>([])
  const [day, setDay] = useState(todayKey)
  const [title, setTitle] = useState('')
  const [time, setTime] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showInbox, setShowInbox] = useState(false)

  useEffect(() => {
    void window.api.planner.list().then(setItems)
    return window.api.planner.onChange(setItems)
  }, [])

  const forDay = useMemo(
    () => items.filter((item) => item.day === day).sort((a, b) => a.order - b.order),
    [items, day]
  )

  const inbox = useMemo(
    () => items.filter((item) => !item.day).sort((a, b) => a.order - b.order),
    [items]
  )

  const open = forDay.filter((item) => !item.done)
  const done = forDay.filter((item) => item.done)

  const add = async (): Promise<void> => {
    const text = title.trim()
    if (!text) return
    const result = await window.api.planner.create({
      title: text,
      day: showInbox ? undefined : day,
      time: time || undefined
    })
    if (result && typeof result === 'object' && 'error' in result) {
      setError((result as { error: string }).error)
      return
    }
    setError(null)
    setTitle('')
    setTime('')
  }

  const toggle = (item: PlanItem): void => {
    void window.api.planner.update(item.id, { done: !item.done, baseVersion: item.version })
  }

  const remove = (item: PlanItem): void => {
    void window.api.planner.delete(item.id)
  }

  const assignToDay = (item: PlanItem): void => {
    void window.api.planner.update(item.id, { day, baseVersion: item.version })
  }

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex flex-none items-center gap-1">
        <button
          className="grid h-7 w-7 place-items-center rounded-[8px] text-text-dim hover:bg-bg-hover hover:text-text"
          title="Предыдущий день"
          onClick={() => setDay((d) => shiftDay(d, -1))}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          className="min-w-0 flex-1 truncate rounded-[8px] px-2 py-1 text-center text-[12px] font-medium text-text hover:bg-bg-hover"
          title="Вернуться к сегодня"
          onClick={() => setDay(todayKey())}
        >
          {formatDayLabel(day)}
        </button>
        <button
          className="grid h-7 w-7 place-items-center rounded-[8px] text-text-dim hover:bg-bg-hover hover:text-text"
          title="Следующий день"
          onClick={() => setDay((d) => shiftDay(d, 1))}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="flex flex-none gap-1">
        <button
          className={`flex-1 rounded-[8px] px-2 py-1 text-[11px] ${
            !showInbox ? 'bg-white/[0.08] text-text' : 'text-text-faint hover:bg-bg-hover'
          }`}
          onClick={() => setShowInbox(false)}
        >
          День · {open.length}
        </button>
        <button
          className={`flex-1 rounded-[8px] px-2 py-1 text-[11px] ${
            showInbox ? 'bg-white/[0.08] text-text' : 'text-text-faint hover:bg-bg-hover'
          }`}
          onClick={() => setShowInbox(true)}
        >
          Без даты · {inbox.length}
        </button>
      </div>

      <div className="flex flex-none gap-1.5">
        <input
          className="min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2.5 py-1.5 text-[12px] text-text outline-none placeholder:text-text-faint focus:border-text-faint"
          placeholder={showInbox ? 'Пункт без даты' : 'Что запланировать'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        {!showInbox && (
          <input
            type="time"
            className="w-[88px] flex-none rounded-[10px] border border-line bg-bg px-1.5 py-1.5 text-[12px] text-text-dim outline-none focus:border-text-faint"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            title="Время (необязательно)"
          />
        )}
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
        {showInbox ? (
          inbox.length === 0 ? (
            <Empty text="Нет пунктов без даты. Добавьте идею сюда, потом перенесите на день." />
          ) : (
            <ul className="flex flex-col gap-1">
              {inbox.map((item) => (
                <PlanRow
                  key={item.id}
                  item={item}
                  onToggle={() => toggle(item)}
                  onRemove={() => remove(item)}
                  secondary={{
                    label: 'На день',
                    onClick: () => assignToDay(item)
                  }}
                />
              ))}
            </ul>
          )
        ) : open.length === 0 && done.length === 0 ? (
          <Empty text="План на этот день пуст. Добавьте пункты выше — это не задачи с доски." />
        ) : (
          <div className="flex flex-col gap-2">
            {open.length > 0 && (
              <ul className="flex flex-col gap-1">
                {open.map((item) => (
                  <PlanRow
                    key={item.id}
                    item={item}
                    onToggle={() => toggle(item)}
                    onRemove={() => remove(item)}
                  />
                ))}
              </ul>
            )}
            {done.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="px-1 pt-1 text-[10px] tracking-wider text-text-faint uppercase">
                  Сделано · {done.length}
                </div>
                {done.map((item) => (
                  <PlanRow
                    key={item.id}
                    item={item}
                    onToggle={() => toggle(item)}
                    onRemove={() => remove(item)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="pt-6 text-center text-[12px] text-text-faint">{text}</p>
}

function PlanRow({
  item,
  onToggle,
  onRemove,
  secondary
}: {
  item: PlanItem
  onToggle: () => void
  onRemove: () => void
  secondary?: { label: string; onClick: () => void }
}): React.JSX.Element {
  return (
    <li className="group flex items-center gap-2 rounded-[10px] border border-line-soft px-2.5 py-1.5">
      <button
        className={`grid h-5 w-5 flex-none place-items-center rounded-full border ${
          item.done
            ? 'border-ok bg-ok/15 text-ok'
            : 'border-line text-transparent hover:border-ok hover:text-ok'
        }`}
        title={item.done ? 'Вернуть в план' : 'Отметить выполненным'}
        onClick={onToggle}
      >
        <Check size={11} />
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-[12px] ${item.done ? 'text-text-faint line-through' : 'text-text'}`}
          title={item.note || item.title}
        >
          {item.title}
        </div>
        {item.time && (
          <div className="text-[10px] text-text-faint tabular-nums">{item.time}</div>
        )}
      </div>
      {secondary && (
        <button
          className="hidden rounded-[6px] px-1.5 py-0.5 text-[10px] text-text-dim hover:bg-bg-hover hover:text-text group-hover:block"
          onClick={secondary.onClick}
        >
          {secondary.label}
        </button>
      )}
      <button
        className="grid h-5 w-5 flex-none place-items-center rounded text-transparent group-hover:text-text-faint hover:!text-danger"
        title="Удалить"
        onClick={onRemove}
      >
        <Trash2 size={11} />
      </button>
    </li>
  )
}
