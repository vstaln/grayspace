import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'

const PANEL_H = 320

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** `YYYY-MM-DD` in local time — matches the value a native `<input type="date">` produces. */
function toKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fromKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!match) return null
  const [, y, m, d] = match
  return new Date(Number(y), Number(m) - 1, Number(d))
}

/** Monday-first weekday index: Sunday (0) becomes 6, everything else shifts down one. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

function addDays(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta)
}

interface Props {
  /** `YYYY-MM-DD`, or empty for "no date chosen". */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
  className?: string
  /** Optional display transform for the trigger label (e.g. "Today", "3 Aug"). */
  formatValue?: (value: string) => string
}

/**
 * A calendar dropdown replacing the OS-themed native `<input type="date">`
 * popup, which does not follow the app's own theme (CANV-31). Value stays the
 * same `YYYY-MM-DD` string a date input produces, so callers do not change.
 */
export default function DatePicker({
  value,
  onChange,
  disabled,
  placeholder = 'Due date',
  ariaLabel = 'Due date',
  className,
  formatValue
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selected = fromKey(value)
  const [viewMonth, setViewMonth] = useState(() => selected ?? new Date())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Reopening should always frame the month the current value is in, not
  // wherever the user last scrolled to.
  const openPicker = useCallback((): void => {
    if (disabled) return
    setViewMonth(fromKey(value) ?? new Date())
    setOpen(true)
  }, [disabled, value])

  useLayoutEffect(() => {
    if (!open) return
    const width = 264
    const reposition = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      // The calendar is ~320px tall; a trigger near the bottom edge would push
      // it past the viewport and get clipped. Flip it above instead. Re-run
      // this when the window moves/resizes so a portal never drifts away from
      // its trigger.
      const below = rect.bottom + 4
      const top = below + PANEL_H > window.innerHeight ? Math.max(4, rect.top - PANEL_H - 4) : below
      setPos({
        left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 4)),
        top
      })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Consume the Escape here, in the CAPTURE phase: without this the same
      // keydown also reaches App's canvas chain and closed whatever panel sits
      // under the picker (e.g. Esc over a planner date closed the Task Board
      // behind it too). Bubble-phase stopPropagation cannot do that — App's
      // own window listener may run first depending on registration order.
      e.stopPropagation()
      e.stopImmediatePropagation()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const pick = (d: Date): void => {
    onChange(toKey(d))
    setOpen(false)
  }

  const today = new Date()
  const monthStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
  const leading = mondayIndex(monthStart)
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate()
  const cells: (Date | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(viewMonth.getFullYear(), viewMonth.getMonth(), i + 1))
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={
          className ??
          'flex h-[30px] min-w-0 flex-none items-center gap-1.5 rounded-[10px] border border-line bg-bg px-2 text-[12px] text-text outline-none transition-colors focus:border-text-faint disabled:opacity-50'
        }
      >
        <Calendar size={13} className="flex-none text-text-faint" aria-hidden />
        <span className={value ? 'truncate' : 'truncate text-text-faint'}>
          {value ? (formatValue ? formatValue(value) : value) : placeholder}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Choose date"
            className="fixed z-[9800] w-[264px] max-w-[calc(100vw-8px)] rounded-[12px] border border-line-soft bg-bg-panel p-2.5 shadow-2xl"
            // Rendered on open but hidden until the layout effect measures the
            // trigger — avoids a first-frame pop-in at the fallback position.
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            // Portal bubbles through the widget tree to <main>: without this a
            // click in the panel also triggers canvas draw/erase/pan gestures.
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="mb-1.5 flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                className="grid h-6 w-6 place-items-center rounded-[8px] text-text-dim hover:bg-bg-hover hover:text-text"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[12px] font-medium text-text">
                {MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                className="grid h-6 w-6 place-items-center rounded-[8px] text-text-dim hover:bg-bg-hover hover:text-text"
              >
                <ChevronRight size={14} />
              </button>
            </div>

            <div
              className="grid grid-cols-7 gap-0.5"
              role="grid"
              aria-label="Choose date"
              onKeyDown={(e) => {
                const active = document.activeElement as HTMLElement | null
                const curKey = active?.dataset?.date
                const cur = curKey ? fromKey(curKey) : null
                if (!cur) return
                let next: Date | null = null
                if (e.key === 'ArrowRight') next = addDays(cur, 1)
                else if (e.key === 'ArrowLeft') next = addDays(cur, -1)
                else if (e.key === 'ArrowDown') next = addDays(cur, 7)
                else if (e.key === 'ArrowUp') next = addDays(cur, -7)
                else return
                e.preventDefault()
                if (next.getFullYear() !== viewMonth.getFullYear() || next.getMonth() !== viewMonth.getMonth()) {
                  setViewMonth(new Date(next.getFullYear(), next.getMonth(), 1))
                }
                const target = toKey(next)
                requestAnimationFrame(() => {
                  panelRef.current?.querySelector<HTMLButtonElement>(`[data-date="${target}"]`)?.focus()
                })
              }}
            >
              {WEEKDAYS.map((w) => (
                <div key={w} className="grid h-6 place-items-center text-[10px] text-text-faint">
                  {w}
                </div>
              ))}
              {cells.map((d, i) => {
                if (!d) return <div key={i} />
                const key = toKey(d)
                const isSelected = key === value
                const isToday = key === toKey(today)
                return (
                  <button
                    key={i}
                    type="button"
                    data-date={key}
                    // Roving tabindex: the selected day (else today) is the tab
                    // stop; arrows move focus within the grid.
                    tabIndex={isSelected || (!value && isToday) ? 0 : -1}
                    onClick={() => pick(d)}
                    aria-current={isToday ? 'date' : undefined}
                    aria-pressed={isSelected}
                    className={`grid h-7 w-7 place-items-center rounded-full text-[12px] transition-colors ${
                      isSelected
                        ? 'bg-accent font-semibold text-bg'
                        : isToday
                          ? 'border border-accent/60 text-text'
                          : 'text-text-dim hover:bg-bg-hover hover:text-text'
                    }`}
                  >
                    {d.getDate()}
                  </button>
                )
              })}
            </div>

            <div className="mt-1.5 flex items-center justify-between border-t border-line-soft pt-1.5">
              <button
                type="button"
                disabled={!value}
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="rounded-[8px] px-2 py-1 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => pick(today)}
                className="rounded-[8px] px-2 py-1 text-[11px] text-accent hover:bg-bg-hover"
              >
                Today
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
