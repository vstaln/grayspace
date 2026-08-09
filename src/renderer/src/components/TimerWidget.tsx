import React, { useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'

const PRESETS = [5, 15, 25, 45]

/**
 * A countdown, and a stopwatch when it runs out.
 *
 * Deliberately the simplest widget in the app: all of its state is in this
 * component, nothing is persisted, and closing it forgets the timer. A timer
 * that survived restarts would have to answer "how much time passed while the
 * app was shut?", and every honest answer to that is useless.
 *
 * Time is tracked as a deadline, not by decrementing a counter on an interval:
 * a background tab throttles its timers, and a counter that ticks slower than
 * a second is a clock that lies.
 */
export default function TimerWidget(): React.JSX.Element {
  const [totalMs, setTotalMs] = useState(25 * 60_000)
  const [remaining, setRemaining] = useState(25 * 60_000)
  const [running, setRunning] = useState(false)
  const deadline = useRef<number>(0)
  const rang = useRef(false)

  useEffect(() => {
    if (!running) return
    const tick = (): void => setRemaining(deadline.current - Date.now())
    tick()
    const timer = setInterval(tick, 200)
    return () => clearInterval(timer)
  }, [running])

  const start = (): void => {
    deadline.current = Date.now() + Math.max(remaining, 1000)
    rang.current = false
    setRunning(true)
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

  const over = remaining <= 0
  // Past zero the widget keeps counting up rather than sitting at 00:00 — the
  // useful question after a timer ends is usually "how long ago".
  const shown = Math.abs(over ? -remaining : remaining)
  const progress = totalMs > 0 ? Math.min(1, Math.max(0, remaining / totalMs)) : 0

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-3">
      <div
        className={`font-mono text-[34px] leading-none tabular-nums ${over ? 'text-danger' : 'text-text'}`}
        role="timer"
        aria-live="off"
      >
        {over && '+'}
        {format(shown)}
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${over ? 'bg-danger' : 'bg-white/70'}`}
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <button
          className="flex items-center gap-1.5 rounded-[10px] border border-line bg-white/[0.03] px-3 py-1.5 text-[12px] text-text hover:bg-bg-hover"
          onClick={() => (running ? pause() : start())}
        >
          {running ? <Pause size={13} /> : <Play size={13} />}
          {running ? 'Пауза' : 'Старт'}
        </button>
        <button
          className="grid h-8 w-8 place-items-center rounded-[10px] border border-line bg-white/[0.03] text-text-dim hover:bg-bg-hover hover:text-text"
          title="Сбросить"
          onClick={() => reset()}
        >
          <RotateCcw size={13} />
        </button>
      </div>

      <div className="flex gap-1">
        {PRESETS.map((min) => (
          <button
            key={min}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              totalMs === min * 60_000
                ? 'border-white/40 text-text'
                : 'border-line-soft text-text-faint hover:text-text-dim'
            }`}
            onClick={() => reset(min * 60_000)}
          >
            {min}м
          </button>
        ))}
      </div>
    </div>
  )
}

function format(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
