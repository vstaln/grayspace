export interface TimerPersist {
  totalMs: number
  remaining: number
  running: boolean
  deadline: number
  rang: boolean
  isCustom: boolean
  customHours: string
  customMinutes: string
  customSeconds: string
}

// Timers survive a React re-parent (maximize/restore), but are explicitly
// removed when their canvas widget is closed. localStorage keeps them alive
// across a maximize-triggered remount without surviving an app restart — the
// honest answer to "how much time passed while the app was shut?" is still
// "reset", and a deadline recomputed as `deadline - Date.now()` on rehydrate
// preserves the running countdown without pretending the gap never happened.
const LS_PREFIX = 'orcspace-timer:'

export const timerPersist = {
  get(id: string): TimerPersist | null {
    try {
      const raw = localStorage.getItem(`${LS_PREFIX}${id}`)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<TimerPersist>
      if (typeof parsed !== 'object' || !parsed) return null
      // Rehydrate a running timer as `deadline - Date.now()` so the countdown
      // keeps ticking against the real clock instead of a stale remaining.
      if (parsed.running && typeof parsed.deadline === 'number') {
        const remaining = Math.max(0, parsed.deadline - Date.now())
        return {
          totalMs: typeof parsed.totalMs === 'number' ? parsed.totalMs : 25 * 60_000,
          remaining,
          running: true,
          deadline: parsed.deadline,
          rang: false,
          isCustom: Boolean(parsed.isCustom),
          customHours: typeof parsed.customHours === 'string' ? parsed.customHours : '0',
          customMinutes: typeof parsed.customMinutes === 'string' ? parsed.customMinutes : '25',
          customSeconds: typeof parsed.customSeconds === 'string' ? parsed.customSeconds : '0'
        }
      }
      return {
        totalMs: typeof parsed.totalMs === 'number' ? parsed.totalMs : 25 * 60_000,
        remaining: typeof parsed.remaining === 'number' ? parsed.remaining : 25 * 60_000,
        running: Boolean(parsed.running),
        deadline: typeof parsed.deadline === 'number' ? parsed.deadline : 0,
        rang: Boolean(parsed.rang),
        isCustom: Boolean(parsed.isCustom),
        customHours: typeof parsed.customHours === 'string' ? parsed.customHours : '0',
        customMinutes: typeof parsed.customMinutes === 'string' ? parsed.customMinutes : '25',
        customSeconds: typeof parsed.customSeconds === 'string' ? parsed.customSeconds : '0'
      }
    } catch {
      return null
    }
  },
  set(id: string, value: TimerPersist): void {
    try {
      localStorage.setItem(`${LS_PREFIX}${id}`, JSON.stringify(value))
    } catch {
      // Private mode or quota blow-up must not take the widget down.
    }
  },
  delete(id: string): void {
    try {
      localStorage.removeItem(`${LS_PREFIX}${id}`)
    } catch {
      /* ignore */
    }
  }
}

export function clearTimerPersist(id: string): void {
  timerPersist.delete(id)
}