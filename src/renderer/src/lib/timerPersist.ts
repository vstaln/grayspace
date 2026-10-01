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







const LS_PREFIX = 'orcspace-timer:'

export const timerPersist = {
  get(id: string): TimerPersist | null {
    try {
      const raw = localStorage.getItem(`${LS_PREFIX}${id}`)
      if (!raw) return null
      const parsed = JSON.parse(raw) as Partial<TimerPersist>
      if (typeof parsed !== 'object' || !parsed) return null


      if (parsed.running && typeof parsed.deadline === 'number') {
        const remaining = Math.max(0, parsed.deadline - Date.now())
        return {
          totalMs: typeof parsed.totalMs === 'number' ? parsed.totalMs : 25 * 60_000,
          remaining,
          running: true,
          deadline: parsed.deadline,
          rang: Boolean(parsed.rang),
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

    }
  },
  delete(id: string): void {
    try {
      localStorage.removeItem(`${LS_PREFIX}${id}`)
    } catch {

    }
  }
}

export function clearTimerPersist(id: string): void {
  timerPersist.delete(id)
}
