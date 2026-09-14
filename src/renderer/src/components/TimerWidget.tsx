import React, { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { timerPersist } from '../lib/timerPersist'

const PRESETS = [5, 15, 25, 45]








export default function TimerWidget({ widgetId }: { widgetId?: string }): React.JSX.Element {
  const persistKey = widgetId ?? '__singleton__'
  const cached = timerPersist.get(persistKey)
  const [totalMs, setTotalMs] = useState(() => cached?.totalMs ?? 25 * 60_000)
  const [remaining, setRemaining] = useState(() => cached?.remaining ?? 25 * 60_000)
  const [running, setRunning] = useState(() => cached?.running ?? false)
  const [isCustom, setIsCustom] = useState(() => cached?.isCustom ?? false)
  const [customHours, setCustomHours] = useState(() => cached?.customHours ?? '0')
  const [customMinutes, setCustomMinutes] = useState(() => cached?.customMinutes ?? '25')
  const [customSeconds, setCustomSeconds] = useState(() => cached?.customSeconds ?? '0')
  const [customError, setCustomError] = useState<string | null>(null)
  const hoursInputRef = useRef<HTMLInputElement>(null)
  const deadline = useRef<number>(cached?.deadline ?? 0)
  const rang = useRef(cached?.rang ?? false)
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)





  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return () => {
      if (titleTimerRef.current !== null) {
        clearTimeout(titleTimerRef.current)
        titleTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (isCustom) {
      hoursInputRef.current?.focus()
      hoursInputRef.current?.select()
    }
  }, [isCustom])




  useEffect(() => {
    if (!widgetId) return
    timerPersist.set(persistKey, {
      totalMs,
      remaining: running ? deadline.current - Date.now() : remaining,
      running,
      deadline: deadline.current,
      rang: rang.current,
      isCustom,
      customHours,
      customMinutes,
      customSeconds
    })
  // NOTE: `remaining` intentionally omitted — while running it is derived from
  // `deadline` (see timerPersist.get), so persisting every tick is wasted sync I/O.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetId, persistKey, totalMs, running, isCustom, customHours, customMinutes, customSeconds])

  useEffect(() => {
    return () => {
      if (!widgetId) return
      timerPersist.set(persistKey, {
        totalMs,
        remaining: deadline.current ? deadline.current - Date.now() : remaining,
        running,
        deadline: deadline.current,
        rang: rang.current,
        isCustom,
        customHours,
        customMinutes,
        customSeconds
      })
    }
  }, [widgetId, persistKey, totalMs, remaining, running, isCustom, customHours, customMinutes, customSeconds])

  useEffect(() => {
    if (!running) return
    const tick = (): void => {


      const visible = rootRef.current?.offsetParent != null
      const left = deadline.current - Date.now()
      if (visible) {
        const shown = Math.max(0, Math.ceil(left / 1000))
        setRemaining((prev) => (Math.max(0, Math.ceil(prev / 1000)) === shown ? prev : left))
      } else if (left > 0) return


      if (left <= 0 && !rang.current) {
        rang.current = true

        if (widgetId) {
          timerPersist.set(persistKey, {
            totalMs,
            remaining: left,
            running,
            deadline: deadline.current,
            rang: true,
            isCustom,
            customHours,
            customMinutes,
            customSeconds
          })
        }
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('OrcSpace', { body: 'Timer finished' })
          }
        } catch {

        }
        try {
          window.dispatchEvent(new CustomEvent('orcspace:title-flash', { detail: '⏱ Timer finished' }))
          const previous = document.title
          document.title = '⏱ Timer — OrcSpace'
          if (titleTimerRef.current !== null) clearTimeout(titleTimerRef.current)
          titleTimerRef.current = setTimeout(() => {
            titleTimerRef.current = null



            if (document.title === '⏱ Timer — OrcSpace') document.title = previous
          }, 4000)
        } catch {

        }
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [running, widgetId, persistKey, totalMs, isCustom, customHours, customMinutes, customSeconds])

  const start = (): void => {
    setIsCustom(false)
    const base = remaining <= 0 ? Math.max(totalMs, 1000) : remaining
    deadline.current = Date.now() + base
    rang.current = false
    setRunning(true)

    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission()
      }
    } catch {

    }
  }

  const pause = (): void => {
    setRemaining(deadline.current - Date.now())
    setRunning(false)
  }

  const reset = (ms = totalMs): void => {
    setRunning(false)
    setTotalMs(ms)
    setRemaining(ms)
    rang.current = false
  }

  const openCustom = (): void => {
    if (running) return
    const totalSec = Math.max(0, Math.floor(totalMs / 1000))
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    setCustomHours(String(h))
    setCustomMinutes(String(m))
    setCustomSeconds(String(s))
    setIsCustom(true)
  }

  const handleCustomSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const h = Math.max(0, Math.min(99, parseInt(customHours, 10) || 0))
    const m = Math.max(0, Math.min(59, parseInt(customMinutes, 10) || 0))
    const s = Math.max(0, Math.min(59, parseInt(customSeconds, 10) || 0))
    const totalSec = h * 3600 + m * 60 + s
    if (totalSec === 0) {
      setCustomError('Enter a duration greater than 0')
      return
    }
    setCustomError(null)
    const ms = totalSec * 1000
    reset(ms)
    setIsCustom(false)
  }

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    setter: React.Dispatch<React.SetStateAction<string>>,
    max: number
  ): void => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setter((prev) => {
        const num = parseInt(prev, 10) || 0
        return String(Math.min(max, num + 1))
      })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setter((prev) => {
        const num = parseInt(prev, 10) || 0
        return String(Math.max(0, num - 1))
      })
    } else if (e.key === 'Escape') {
      setIsCustom(false)
    }
  }

  const over = remaining <= 0


  const shown = Math.abs(over ? -remaining : remaining)
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, remaining / totalMs)) : 0
  const isPresetActive = !isCustom && PRESETS.some((min) => totalMs === min * 60_000)

  return (
    <div ref={rootRef} className="flex h-full flex-col items-center justify-center gap-3 p-3">
      <button
        type="button"
        disabled={running}
        className={`font-mono text-[clamp(20px,4vw,34px)] leading-none tabular-nums ${over ? 'text-danger' : 'text-text'} ${
          !running ? 'cursor-pointer select-none hover:opacity-80' : 'cursor-default'
        } disabled:cursor-default`}
        aria-label={!running ? 'Timer value. Activate to set custom duration' : 'Timer value'}
        onClick={() => {
          if (!running) openCustom()
        }}
        title={!running ? 'Click to set custom duration' : undefined}
      >
        <span role="timer" aria-live="off">
          {over && '+'}
          {format(shown, totalMs)}
        </span>
      </button>

      <div
        className="h-2 w-full overflow-hidden rounded-pill bg-bg-hover"
        role="progressbar"
        aria-label="Timer progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <div
          className={`h-full rounded-pill transition-[width] duration-200 ease-out ${over ? 'bg-danger' : 'bg-accent/70'}`}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      {over && (
        <div role="status" aria-live="polite" className="sr-only">
          Timer finished
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          className="flex items-center gap-1.5 rounded-panel border border-line bg-bg-hover/40 px-3 py-1.5 text-[12px] text-text transition-colors duration-150 hover:bg-bg-hover"
          onClick={() => (running ? pause() : start())}
          aria-label={running ? 'Pause' : 'Start'}
        >
          {running ? <Pause size={13} /> : <Play size={13} />}
          {running ? 'Pause' : 'Start'}
        </button>
        <button
          className="grid h-8 w-8 place-items-center rounded-pill border border-line bg-bg-hover/40 text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text"
          title="Reset"
          aria-label="Reset timer"
          onClick={() => reset()}
        >
          <RotateCcw size={13} />
        </button>
      </div>

      {isCustom ? (
        <form
          onSubmit={handleCustomSubmit}
          className="flex flex-col items-center gap-1.5"
          data-testid="timer-custom-form"
        >
          <div className="flex items-center gap-1 font-mono text-text">
            <div className="flex flex-col items-center">
              <input
                ref={hoursInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={2}
                value={customHours}
                onChange={(e) => setCustomHours(e.target.value.replace(/\D/g, '').slice(0, 2))}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => handleKeyDown(e, setCustomHours, 99)}
                placeholder="0"
                className="h-6 w-9 rounded-panel border border-line bg-bg-raise text-center text-xs text-text outline-none transition-colors focus:border-accent"
                aria-label="Hours"
                title="Hours (0-99)"
              />
              <span className="text-[9px] font-sans text-text-faint">h</span>
            </div>
            <span className="mb-3.5 text-xs font-bold text-text-faint">:</span>
            <div className="flex flex-col items-center">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={2}
                value={customMinutes}
                onChange={(e) => setCustomMinutes(e.target.value.replace(/\D/g, '').slice(0, 2))}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => handleKeyDown(e, setCustomMinutes, 59)}
                placeholder="0"
                className="h-6 w-9 rounded-panel border border-line bg-bg-raise text-center text-xs text-text outline-none transition-colors focus:border-accent"
                aria-label="Minutes"
                title="Minutes (0-59)"
              />
              <span className="text-[9px] font-sans text-text-faint">m</span>
            </div>
            <span className="mb-3.5 text-xs font-bold text-text-faint">:</span>
            <div className="flex flex-col items-center">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={2}
                value={customSeconds}
                onChange={(e) => setCustomSeconds(e.target.value.replace(/\D/g, '').slice(0, 2))}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => handleKeyDown(e, setCustomSeconds, 59)}
                placeholder="0"
                className="h-6 w-9 rounded-panel border border-line bg-bg-raise text-center text-xs text-text outline-none transition-colors focus:border-accent"
                aria-label="Seconds"
                title="Seconds (0-59)"
              />
              <span className="text-[9px] font-sans text-text-faint">s</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="submit"
              className="rounded-panel bg-accent px-2.5 py-0.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
            >
              Set
            </button>
            <button
              type="button"
              onClick={() => {
                setCustomError(null)
                setIsCustom(false)
              }}
              className="rounded-panel border border-line bg-bg-hover/40 px-2.5 py-0.5 text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            >
              Cancel
            </button>
          </div>
          {customError && (
            <div role="alert" className="text-[11px] text-danger">
              {customError}
            </div>
          )}
        </form>
      ) : (
        <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Presets">
          {PRESETS.map((min) => (
            <button
              key={min}
              className={`rounded-pill border px-2.5 py-0.5 text-[11px] transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${
                totalMs === min * 60_000 && isPresetActive
                  ? 'border-line text-text'
                  : 'border-line-soft text-text-faint hover:text-text-dim'
              }`}
              aria-pressed={totalMs === min * 60_000 && isPresetActive}
              disabled={running}
              onClick={() => {
                setIsCustom(false)
                reset(min * 60_000)
              }}
            >
              {min}m
            </button>
          ))}
          <button
            className={`rounded-pill border px-2.5 py-0.5 text-[11px] transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${
              !isPresetActive
                ? 'border-line text-text'
                : 'border-line-soft text-text-faint hover:text-text-dim'
            }`}
            aria-pressed={!isPresetActive}
            disabled={running}
            onClick={openCustom}
            title="Set custom duration (hours, minutes, seconds)"
          >
            Custom
          </button>
        </div>
      )}
    </div>
  )
}

function format(ms: number, totalMs = 0): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0 || totalMs >= 3600_000) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

