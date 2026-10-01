import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { PlanItem } from '../../../preload/index.d'
import { todayKey } from '../lib/dayKey'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday-first 6x7 grid of day keys covering the month `anchor` falls in, including the leading/trailing days needed to fill whole weeks. */
function monthGrid(anchor: Date): { key: string; inMonth: boolean }[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const firstWeekday = (first.getDay() + 6) % 7 // 0 = Monday
  const start = new Date(first)
  start.setDate(start.getDate() - firstWeekday)
  const days: { key: string; inMonth: boolean }[] = []
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      inMonth: d.getMonth() === anchor.getMonth()
    })
  }
  return days
}

function readCalendarState(widgetId: string): { anchor: Date; selectedDay: string | null } {
  const fallback = { anchor: new Date(), selectedDay: null }
  try {
    const saved = JSON.parse(localStorage.getItem(`orcspace-calendar:${widgetId}`) || 'null') as {
      year?: unknown
      month?: unknown
      selectedDay?: unknown
    } | null
    const year = saved?.year
    const month = saved?.month
    const anchor = typeof year === 'number' && Number.isInteger(year) && year >= 1970 && year <= 9999 &&
      typeof month === 'number' && Number.isInteger(month) && month >= 0 && month <= 11
      ? new Date(year, month, 1)
      : fallback.anchor
    const selectedDay = typeof saved?.selectedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.selectedDay)
      ? saved.selectedDay
      : null
    return { anchor, selectedDay }
  } catch {
    return fallback
  }
}

export default function CalendarWidget({ widgetId }: { widgetId: string }): React.JSX.Element {
  const [savedState] = useState(() => readCalendarState(widgetId))
  const [items, setItems] = useState<PlanItem[]>([])
  const [anchor, setAnchor] = useState(() => savedState.anchor)
  const [selectedDay, setSelectedDay] = useState<string | null>(() => savedState.selectedDay)
  const [quickAdd, setQuickAdd] = useState('')
  const [adding, setAdding] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    let mounted = true
    void window.api.planner
      .list()
      .then((next) => {
        if (mounted) setItems(next)
      })
      .catch(() => {})
    const unbind = window.api.planner.onChange((next) => {
      if (mounted) setItems(next)
    })
    return () => {
      aliveRef.current = false
      mounted = false
      unbind()
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(`orcspace-calendar:${widgetId}`, JSON.stringify({
        year: anchor.getFullYear(),
        month: anchor.getMonth(),
        selectedDay
      }))
    } catch {}
  }, [widgetId, anchor, selectedDay])

  const byDay = useMemo(() => {
    const map = new Map<string, PlanItem[]>()
    for (const item of items) {
      if (!item.day) continue
      const list = map.get(item.day) ?? []
      list.push(item)
      map.set(item.day, list)
    }
    return map
  }, [items])

  const grid = useMemo(() => monthGrid(anchor), [anchor])
  const today = todayKey()
  const monthLabel = anchor.toLocaleDateString('en', { month: 'long', year: 'numeric' })

  const addToDay = async (day: string): Promise<void> => {
    const title = quickAdd.trim()
    if (!title || adding) return
    setAdding(true)
    try {
      const result = await window.api.planner.create({ title, day })
      if (!aliveRef.current) return
      if ('error' in result) {
        setActionError(result.error)
        return
      }
      setQuickAdd('')
      setActionError(null)
    } catch (error) {
      if (aliveRef.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (aliveRef.current) setAdding(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-line-soft px-3.5 py-2.5">
        <div className="text-[14px] font-semibold tracking-tight text-text">{monthLabel}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-pill text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="rounded-panel border border-line-soft px-2 py-1 text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            onClick={() => setAnchor(new Date())}
          >
            Today
          </button>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-pill text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="grid flex-none grid-cols-7 gap-px border-b border-line-soft bg-line-soft/40 px-px pt-px">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="bg-bg-panel py-1 text-center text-[9px] font-medium tracking-wide text-text-faint uppercase">
            {label}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px overflow-hidden bg-line-soft/40 px-px pb-px">
        {grid.map(({ key, inMonth }) => {
          const dayItems = byDay.get(key) ?? []
          const isToday = key === today
          const isSelected = key === selectedDay
          return (
            <button
              key={key}
              type="button"
              className={`flex min-h-0 flex-col items-start gap-0.5 overflow-hidden bg-bg-panel p-1 text-left transition-colors hover:bg-bg-hover/60 ${
                inMonth ? '' : 'opacity-40'
              } ${isSelected ? 'ring-1 ring-inset ring-accent' : ''}`}
              onClick={() => setSelectedDay((cur) => (cur === key ? null : key))}
            >
              <span className={`text-[10px] tabular-nums ${isToday ? 'grid h-4 w-4 place-items-center rounded-pill bg-accent font-semibold text-bg' : 'text-text-dim'}`}>
                {Number(key.slice(-2))}
              </span>
              <div className="flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-hidden">
                {dayItems.slice(0, 3).map((item) => (
                  <span
                    key={item.id}
                    className={`truncate rounded-panel px-1 py-0.5 text-[9px] leading-tight ${
                      item.done ? 'bg-bg-hover text-text-faint line-through' : 'bg-accent/15 text-text'
                    }`}
                  >
                    {item.title}
                  </span>
                ))}
                {dayItems.length > 3 && <span className="text-[9px] text-text-faint">+{dayItems.length - 3} more</span>}
              </div>
            </button>
          )
        })}
      </div>

      {selectedDay && (
        <div className="flex-none border-t border-line-soft p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-text-dim">
            <span>{selectedDay}</span>
            <span>{(byDay.get(selectedDay) ?? []).length} task(s)</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-panel bg-bg-hover/20 px-2 py-1.5">
            <Plus size={13} className="flex-none text-text-faint" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-text-faint"
              placeholder={`Add a task for ${selectedDay}…`}
              value={quickAdd}
              disabled={adding}
              onChange={(e) => setQuickAdd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addToDay(selectedDay)
              }}
            />
          </div>
          {actionError && <div role="alert" className="mt-1.5 text-[10px] text-danger">{actionError}</div>}
        </div>
      )}
    </div>
  )
}
