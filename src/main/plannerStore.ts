import { app } from 'electron'
import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'
import { CommandError, VersionRegistry } from './core/index.ts'

/** Bumped whenever the persisted shape changes. */
export const PLANNER_SCHEMA_VERSION = 1

/**
 * One line on the plan: a thing to do, optionally slotted to a day and time.
 * Deliberately not a board task — a task is a unit of *delegable* work with an
 * assignee and a state machine; a plan item is the human's own outline for a
 * day, kept even after it's done, ordered by hand rather than by deadline.
 */
export interface PlanItem {
  id: string
  title: string
  note: string
  /** `YYYY-MM-DD`, or unset for a plan item with no particular day. */
  day?: string
  /** `HH:MM`, or unset for a day item with no particular time. */
  time?: string
  done: boolean
  createdBy: string
  /** Manual ordering within a day — drag-reordered, not sorted by field. */
  order: number
  createdAt: number
  updatedAt: number
  /** Optimistic-concurrency version, owned by the Command Bus. */
  version: number
}

/**
 * The planner: a flat, hand-ordered outline, persisted per profile like the
 * task board and the brain. Mutating methods are called only from
 * `commands/planner.ts` — this class has no other write path, same as every
 * other store behind the unified core.
 */
export class PlannerStore extends EventEmitter {
  private readonly items = new Map<string, PlanItem>()
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  readonly versions = new VersionRegistry('plan')

  private get file(): string {
    return join(app.getPath('userData'), 'workspace-planner.json')
  }

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    const items = Array.isArray(raw.items) ? raw.items : []
    for (const entry of items) {
      const item = revive(entry)
      if (item) this.items.set(item.id, item)
    }
    this.versions.seed(this.items.values())
  }

  private changed(): void {
    this.emit('change', this.list())
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flush()
    }, 250)
  }

  private flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      writeJsonAtomic(this.file, { schemaVersion: PLANNER_SCHEMA_VERSION, items: Array.from(this.items.values()) })
    } catch (err) {
      console.error('failed to persist planner', err)
    }
  }

  /** Flushes any pending write; call from the app's shutdown path. */
  dispose(): void {
    this.flush()
  }

  private nextId(): string {
    this.counter += 1
    return `plan-${Date.now()}-${this.counter}`
  }

  private nextOrder(day: string | undefined): number {
    let max = -1
    for (const item of this.items.values()) {
      if (item.day === day) max = Math.max(max, item.order)
    }
    return max + 1
  }

  list(): PlanItem[] {
    this.ensure()
    return Array.from(this.items.values()).sort((a, b) => {
      const day = (a.day ?? '').localeCompare(b.day ?? '')
      if (day !== 0) return a.day ? (b.day ? day : -1) : b.day ? 1 : 0
      return a.order - b.order
    })
  }

  createItem(input: { title?: string; note?: string; day?: string; time?: string; createdBy: string }): PlanItem {
    this.ensure()
    const title = input.title?.trim()
    if (!title) throw new CommandError('invalid', 'title is required')
    const day = normalizeDay(input.day)
    const now = Date.now()
    const id = this.nextId()
    const item: PlanItem = {
      id,
      title,
      note: typeof input.note === 'string' ? input.note : '',
      day,
      time: normalizeTime(input.time),
      done: false,
      createdBy: input.createdBy,
      order: this.nextOrder(day),
      createdAt: now,
      updatedAt: now,
      version: this.versions.bump(id)
    }
    this.items.set(id, item)
    this.changed()
    return item
  }

  updateItem(
    id: string,
    patch: { title?: string; note?: string; day?: string | null; time?: string | null; done?: boolean; order?: number }
  ): PlanItem {
    this.ensure()
    const item = this.items.get(id)
    if (!item) throw new CommandError('not_found', 'plan item not found')
    if (typeof patch.title === 'string' && patch.title.trim()) item.title = patch.title.trim()
    if (typeof patch.note === 'string') item.note = patch.note
    if (patch.day !== undefined) item.day = patch.day === null ? undefined : normalizeDay(patch.day)
    if (patch.time !== undefined) item.time = patch.time === null ? undefined : normalizeTime(patch.time)
    if (typeof patch.done === 'boolean') item.done = patch.done
    if (typeof patch.order === 'number' && Number.isFinite(patch.order)) item.order = patch.order
    item.updatedAt = Date.now()
    item.version = this.versions.bump(id)
    this.changed()
    return item
  }

  deleteItem(id: string): void {
    this.ensure()
    if (!this.items.has(id)) throw new CommandError('not_found', 'plan item not found')
    this.items.delete(id)
    this.versions.forget(id)
    this.changed()
  }
}

/** Accepts `YYYY-MM-DD` only — anything else is treated as no day. */
function normalizeDay(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

/** Accepts `HH:MM` only — anything else is treated as no time. */
function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^\d{2}:\d{2}$/.test(value) ? value : undefined
}

function revive(entry: unknown): PlanItem | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null
  const now = Date.now()
  return {
    id,
    title,
    note: typeof raw.note === 'string' ? raw.note : '',
    day: normalizeDay(raw.day),
    time: normalizeTime(raw.time),
    done: raw.done === true,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : 'user',
    order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    version: Number(raw.version) > 0 ? Number(raw.version) : 1
  }
}
