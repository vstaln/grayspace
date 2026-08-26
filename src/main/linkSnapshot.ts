import { CONTROL_PORT, mcpUrl } from './config.ts'

export const APP_VERSION = '2.0.0'

export interface PresenceInfo {
  ok: true
  app: 'orcspace'
  version: string
  pid: number
  controlPort: number
  /** Deprecated compatibility field; it is always the same TCP port as controlPort. */
  mcpPort: number
  mcpUrl: string
  mcpRunning: boolean
  workspaceDir: string | null
}

export interface SnapshotInfo extends PresenceInfo {
  managerId: string | null
  terminals: unknown[]
  widgets: unknown[]
  tasks: unknown[]
  locks: unknown[]
  planner: {
    items: unknown[]
    summary: PlannerSummary
  }
  brain: {
    count: number
    notes: Array<{ id: string; title: string; tags: string[]; updatedAt: number }>
  }
  journal: { lastSeq: number; entries: unknown[] }
  commands: string[]
  mcp?: { running: boolean; error?: string; pid?: number; restarts?: number }
}

export interface PlannerSummary {
  total: number
  open: number
  done: number
  today: number
  todayOpen: number
  week: number
  weekOpen: number
  projects: string[]
}

export function buildPresence(input: {
  mcpRunning: boolean
  workspaceDir: string | null | undefined
  pid?: number
}): PresenceInfo {
  return {
    ok: true,
    app: 'orcspace',
    version: APP_VERSION,
    pid: input.pid ?? process.pid,
    controlPort: CONTROL_PORT,
    mcpPort: CONTROL_PORT,
    mcpUrl: mcpUrl(),
    mcpRunning: Boolean(input.mcpRunning),
    workspaceDir: input.workspaceDir ?? null
  }
}

/** Secret-bearing keys that must never appear on /presence or in runtime.json. */
export const FORBIDDEN_PRESENCE_KEYS = [
  'token',
  'controlToken',
  'ORCSPACE_CONTROL_TOKEN',
  'headers',
  'authorization',
  'cookie'
] as const

export function presenceLeaksSecrets(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key
      if ((FORBIDDEN_PRESENCE_KEYS as readonly string[]).includes(key)) found.push(next)
      walk(child, next)
    }
  }
  walk(value, '')
  return found
}

export function summarizePlanner(items: Array<{ day?: string; done?: boolean; project?: string }>): PlannerSummary {
  const today = localDayKey()
  const weekEnd = shiftLocalDay(today, 6)
  const open = items.filter((i) => !i.done)
  const done = items.filter((i) => i.done)
  const todayItems = items.filter((i) => i.day === today)
  const weekItems = items.filter((i) => i.day && i.day >= today && i.day <= weekEnd)
  return {
    total: items.length,
    open: open.length,
    done: done.length,
    today: todayItems.length,
    todayOpen: todayItems.filter((i) => !i.done).length,
    week: weekItems.length,
    weekOpen: weekItems.filter((i) => !i.done).length,
    projects: uniqueProjects(items)
  }
}

export function buildSnapshot(input: {
  mcpRunning: boolean
  workspaceDir: string | null | undefined
  managerId: string | null
  terminals: unknown[]
  widgets: unknown[]
  tasks: unknown[]
  locks: unknown[]
  plannerItems: Array<{ day?: string; done?: boolean; project?: string }>
  brainNotes: Array<{ id: string; title: string; tags?: string[]; updatedAt: number; deletedAt?: number }>
  journal: { lastSeq: number; entries: unknown[] }
  commands: string[]
  mcp?: { running: boolean; error?: string; pid?: number; restarts?: number }
}): SnapshotInfo {
  const aliveNotes = input.brainNotes.filter((n) => !n.deletedAt)
  return {
    ...buildPresence(input),
    managerId: input.managerId,
    terminals: input.terminals,
    widgets: input.widgets,
    tasks: input.tasks,
    locks: input.locks,
    planner: {
      items: input.plannerItems,
      summary: summarizePlanner(input.plannerItems)
    },
    brain: {
      count: aliveNotes.length,
      notes: aliveNotes.map((n) => ({
        id: n.id,
        title: n.title,
        tags: n.tags ?? [],
        updatedAt: n.updatedAt
      }))
    },
    journal: input.journal,
    commands: input.commands,
    mcp: input.mcp
  }
}

function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftLocalDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + delta)
  return localDayKey(date)
}

function uniqueProjects(items: { project?: string }[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const p = item.project?.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}
