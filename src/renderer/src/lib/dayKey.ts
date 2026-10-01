/** YYYY-MM-DD day keys, shared by Planner, Calendar and Kanban so all three agree on "today". */

export function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return todayKey(date)
}

export function formatDayShort(key: string): string {
  const today = todayKey()
  if (key === today) return 'Today'
  if (key === shiftDay(today, 1)) return 'Tomorrow'
  if (key === shiftDay(today, -1)) return 'Yesterday'
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en', { day: 'numeric', month: 'short' })
}
