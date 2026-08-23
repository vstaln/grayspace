import React, { useEffect, useMemo, useState } from 'react'
import { useConfirm } from './ConfirmDialog'
import { Check, Plus, Trash2 } from 'lucide-react'
import DatePicker from './DatePicker'
import type { PlanItem } from '../../../preload/index.d'

type Scope = 'all' | 'today' | 'week' | 'inbox'

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

function formatDayShort(key: string): string {
  const today = todayKey()
  if (key === today) return 'Today'
  if (key === shiftDay(today, 1)) return 'Tomorrow'
  if (key === shiftDay(today, -1)) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en', { day: 'numeric', month: 'short' })
}

function inWeek(day: string | undefined, today: string, weekEnd: string): boolean {
  return Boolean(day && day >= today && day <= weekEnd)
}

/**
 * Personal day outline — checklist UI (not the board schedule).
 *
 * Matches a Linear/Nexa-style task list: scope chips, progress counter,
 * numbered rows with circle checkboxes. Checking one off does not move a
 * board card. Agents see the same data via MCP list_plan_items / toggle_plan_item.
 */
export default function PlannerWidget(): React.JSX.Element {
  const [items, setItems] = useState<PlanItem[]>([])
  const [scope, setScope] = useState<Scope>('today')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const [today, setToday] = useState(() => todayKey())
  const confirm = useConfirm()

  useEffect(() => {
    void window.api.planner.list().then(setItems).catch(() => setError('Failed to load planner items'))
    const unbind = window.api.planner.onChange(setItems)
    const dayTimer = setInterval(() => {
      const current = todayKey()
      setToday((prev) => (prev !== current ? current : prev))
    }, 30_000)
    return () => {
      unbind()
      clearInterval(dayTimer)
    }
  }, [])

  const weekEnd = shiftDay(today, 6)

  const projects = useMemo(() => {
    const seen = new Set<string>()
    const list: string[] = []
    for (const item of items) {
      const p = item.project?.trim()
      if (!p || seen.has(p)) continue
      seen.add(p)
      list.push(p)
    }
    return list.sort((a, b) => a.localeCompare(b))
  }, [items])

  const scoped = useMemo(() => {
    let list = items
    if (scope === 'today') list = list.filter((i) => i.day === today)
    else if (scope === 'week') list = list.filter((i) => inWeek(i.day, today, weekEnd))
    else if (scope === 'inbox') list = list.filter((i) => !i.day)
    if (projectFilter) list = list.filter((i) => (i.project ?? '') === projectFilter)
    return [...list].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      const day = (a.day ?? '').localeCompare(b.day ?? '')
      if (day !== 0) return a.day ? (b.day ? day : -1) : b.day ? 1 : 0
      return a.order - b.order
    })
  }, [items, scope, projectFilter, today, weekEnd])

  const openCount = scoped.filter((i) => !i.done).length
  const totalCount = scoped.length
  const doneCount = totalCount - openCount

  const headerTitle = projectFilter
    ? projectFilter
    : scope === 'today'
      ? 'Today'
      : scope === 'week'
        ? 'This Week'
        : scope === 'inbox'
          ? 'Inbox (No Date)'
          : 'All Tasks'

  const add = async (): Promise<void> => {
    const text = title.trim()
    if (!text || creating) return
    const day =
      // "Today" and "Week" pin the created line to today — the week view only
      // renders items with a date inside the current window, so a dayless item
      // added there would silently disappear. "Inbox" means "no date" and
      // "All" is deliberately left alone: stamping today on those would drop
      // the line into a day bucket the user never chose.
      scope === 'inbox' || scope === 'all' ? undefined : todayKey()
    setCreating(true)
    try {
      const result = await window.api.planner.create({
        title: text,
        day,
        // With a project filter active the project input is hidden, so any
        // leftover typed value is stale — the active filter must win.
        project: (projectFilter || project.trim() || undefined) ?? undefined
      })
      if (result && typeof result === 'object' && 'error' in result) {
        setError(result.error)
        return
      }
      setError(null)
      setTitle((current) => (current.trim() === text ? '' : current))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const runItemAction = async (item: PlanItem, action: () => Promise<unknown>): Promise<void> => {
    if (pendingIds.has(item.id)) return
    setPendingIds((current) => new Set(current).add(item.id))
    try {
      const result = await action()
      if (result && typeof result === 'object' && 'error' in result) setError(String(result.error))
      else setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingIds((current) => {
        const next = new Set(current)
        next.delete(item.id)
        return next
      })
    }
  }

  const toggle = (item: PlanItem): void => void runItemAction(item, () => window.api.planner.toggle(item.id, !item.done, item.version))

  const reschedule = (item: PlanItem, day: string): void =>
    void runItemAction(item, () => window.api.planner.update(item.id, { day: day || null, baseVersion: item.version }))

  const remove = (item: PlanItem): void => {
    void confirm(`Delete “${item.title}”?`, {
      danger: true,
      title: 'Delete plan line',
      confirmLabel: 'Delete'
    }).then((ok) => {
      if (ok) void runItemAction(item, () => window.api.planner.delete(item.id))
    })
  }

  const scopes: { id: Scope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'today', label: 'Today' },
    { id: 'week', label: 'Week' },
    { id: 'inbox', label: 'Inbox' }
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: title + progress */}
      <div className="flex flex-none items-start justify-between gap-3 border-b border-line-soft px-3.5 pt-3 pb-2.5">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold tracking-tight text-text">{headerTitle}</div>
          {projectFilter && (
            <button
              type="button"
              className="mt-0.5 text-[11px] text-text-faint transition-colors hover:text-text-dim"
              onClick={() => setProjectFilter(null)}
            >
              ← All projects
            </button>
          )}
        </div>
        <div
          className="flex-none rounded-full border border-line-soft bg-bg-hover/40 px-2 py-0.5 text-[11px] tabular-nums text-text-dim"
          title={`${doneCount} completed out of ${totalCount}`}
        >
          {doneCount} of {totalCount}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Project rail */}
        {projects.length > 0 && (
          <aside className="flex w-[118px] flex-none flex-col gap-0.5 overflow-auto border-r border-line-soft px-1.5 py-2">
            <div className="px-1.5 pb-1 text-[9px] font-medium tracking-wider text-text-faint uppercase">
              Projects
            </div>
            <button
              type="button"
              className={`rounded-[8px] px-1.5 py-1 text-left text-[11px] transition-colors ${
                !projectFilter ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover/60 hover:text-text'
              }`}
              onClick={() => setProjectFilter(null)}
            >
              All
            </button>
            {projects.map((p) => {
              const count = items.filter((i) => i.project === p && !i.done).length
              return (
                <button
                  key={p}
                  type="button"
                  title={p}
                  className={`flex items-center gap-1 rounded-[8px] px-1.5 py-1 text-left text-[11px] transition-colors ${
                    projectFilter === p
                      ? 'bg-bg-hover text-text'
                      : 'text-text-dim hover:bg-bg-hover/60 hover:text-text'
                  }`}
                  onClick={() => setProjectFilter(p)}
                >
                  <span className="min-w-0 flex-1 truncate">{p}</span>
                  {count > 0 && (
                    <span className="flex-none text-[10px] tabular-nums text-text-faint">{count}</span>
                  )}
                </button>
              )
            })}
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-auto">
          {/* Scope chips */}
          <div
            className="flex flex-none flex-wrap gap-1 px-3 pt-2.5 pb-1.5"
            role="tablist"
            aria-label="Planner scope"
            onKeyDown={(e) => {
              // Roving focus for the tab pattern: arrows move selection and
              // focus together, matching how screen readers announce tabs.
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              e.preventDefault()
              const delta = e.key === 'ArrowRight' ? 1 : -1
              const idx = scopes.findIndex((s) => s.id === scope)
              const next = (idx + delta + scopes.length) % scopes.length
              setScope(scopes[next].id)
              const chips = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              chips[next]?.focus()
            }}
          >
            {scopes.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={scope === s.id}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                  scope === s.id
                    ? 'bg-bg-hover text-text'
                    : 'text-text-faint hover:bg-bg-hover/50 hover:text-text-dim'
                }`}
                onClick={() => setScope(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* Add row */}
          <div className="flex flex-none flex-col gap-1.5 px-3 pb-2">
            <div className="flex items-center gap-2 rounded-[12px] bg-bg-hover/20 px-2.5 py-1.5">
              <Plus size={14} className="flex-none text-text-faint" aria-hidden />
              <input
                className="min-w-0 flex-1 bg-transparent px-px text-[12px] text-text outline-none placeholder:text-text-faint"
                placeholder="Add a task…"
                value={title}
                disabled={creating}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                aria-label="New planner item"
              />
              <button
                type="button"
                className="flex h-6 flex-none items-center rounded-[8px] bg-accent px-2.5 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-30"
                disabled={creating || !title.trim()}
                title="Add"
                aria-label="Add item"
                onClick={() => void add()}
              >
                Add
              </button>
            </div>
            {!projectFilter && (
              <input
                className="rounded-[10px] border border-line-soft bg-transparent px-2.5 py-1 text-[11px] text-text-dim outline-none placeholder:text-text-faint focus:border-line"
                placeholder="Project (optional)"
                value={project}
                disabled={creating}
                onChange={(e) => setProject(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
                aria-label="Project"
              />
            )}
            {error && <p className="text-[11px] text-danger">{error}</p>}
          </div>

          {/* Checklist */}
          <div className="px-2 pb-2">
            {scoped.length === 0 ? (
              <Empty
                text={
                  scope === 'today'
                    ? 'Nothing planned for today. Add a task above — items persist and sync with MCP.'
                    : scope === 'inbox'
                      ? 'No unscheduled tasks. Use inbox to drop ideas and assign dates later.'
                      : 'Plan list is empty. Add tasks above to track your day.'
                }
              />
            ) : (
              <ul className="flex flex-col">
                {scoped.map((item, index) => (
                  <PlanRow
                    key={item.id}
                    item={item}
                    index={index + 1}
                    showDay={scope !== 'today'}
                    pending={pendingIds.has(item.id)}
                    onToggle={() => toggle(item)}
                    onRemove={() => remove(item)}
                    onReschedule={(day) => reschedule(item, day)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="px-3 pt-8 text-center text-[12px] leading-relaxed text-text-faint">{text}</p>
}

function PlanRow({
  item,
  index,
  showDay,
  pending,
  onToggle,
  onRemove,
  onReschedule
}: {
  item: PlanItem
  index: number
  showDay: boolean
  pending: boolean
  onToggle: () => void
  onRemove: () => void
  onReschedule: (day: string) => void
}): React.JSX.Element {
  return (
    <li className="group flex items-start gap-2.5 rounded-[12px] px-2 py-2 transition-colors hover:bg-bg-hover/40 focus-within:bg-bg-hover/40">
      <button
        type="button"
        className={`mt-0.5 grid h-[18px] w-[18px] flex-none place-items-center rounded-full border transition-colors duration-150 ${
          item.done
            ? 'border-ok bg-ok/20 text-ok'
            : 'border-line text-transparent hover:border-ok hover:text-ok/70'
        }`}
        title={item.done ? 'Mark incomplete' : 'Mark completed'}
        aria-label={item.done ? 'Mark incomplete' : 'Mark completed'}
        aria-pressed={item.done}
        disabled={pending}
        onClick={onToggle}
      >
        <Check size={11} strokeWidth={2.5} />
      </button>

      <div className="min-w-0 flex-1 pt-px">
        <div className="flex items-baseline gap-1.5">
          <span className="flex-none text-[11px] tabular-nums text-text-faint">{index}</span>
          <span
            className={`min-w-0 text-[12.5px] leading-snug ${
              item.done ? 'text-text-faint line-through' : 'text-text'
            }`}
            title={item.note || item.title}
          >
            {item.title}
          </span>
        </div>
        {(item.note || item.project || item.time || showDay) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px] text-[10px] text-text-faint">
            {item.project && <span className="text-text-dim">{item.project}</span>}
            {showDay && (
              <DatePicker
                value={item.day ?? ''}
                onChange={onReschedule}
                placeholder="No date"
                ariaLabel={`Schedule date for ${item.title}`}
                disabled={pending}
                formatValue={formatDayShort}
                className="-mx-1 flex h-auto flex-none items-center gap-1 rounded-[6px] border border-transparent px-1 py-0 text-[10px] tabular-nums text-text-faint transition-colors hover:border-line-soft hover:text-text-dim"
              />
            )}
            {item.time && <span className="tabular-nums">{item.time}</span>}
            {item.note && <span className="truncate opacity-80">{item.note}</span>}
          </div>
        )}
      </div>

      <button
        type="button"
        className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-[8px] text-text-faint/70 transition-colors group-hover:text-text-faint group-focus-within:text-text-faint hover:!text-danger"
        title="Delete"
        aria-label="Delete item"
        disabled={pending}
        onClick={onRemove}
      >
        <Trash2 size={12} />
      </button>
    </li>
  )
}
