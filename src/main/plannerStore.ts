import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { notifyPersistError } from './persistNotifier.ts'
import {
  CommandError,
  VersionRegistry,
  fold,
  rewind as rewindHelper,
  blame as blameHelper,
  fork as forkHelper,
  type JournalEntry,
  type ResourceId
} from './core/index.ts'


export const PLANNER_SCHEMA_VERSION = 2


export const PLANNER_SNAPSHOT_INTERVAL = 50






export interface PlanItem {
  id: string
  title: string
  note: string

  project?: string

  day?: string

  time?: string
  done: boolean
  createdBy: string

  order: number
  createdAt: number
  updatedAt: number

  version: number

  attachments?: string[]
}

export interface PlannerSnapshot {
  snapshotSeq: number
  schemaVersion: number
  items: PlanItem[]
}

export type PlannerState = Map<string, PlanItem>






export class PlannerStore extends EventEmitter {
  private readonly items = new Map<string, PlanItem>()
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotSeq = 0
  private eventsSinceSnapshot = 0

  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushedSeq = 0
  readonly versions = new VersionRegistry('plan')

  private get file(): string {
    return join(getUserDataDir(), 'workspace-planner.json')
  }






  static reduce(state: PlannerState, event: JournalEntry): PlannerState {
    if (event.phase !== 'commit') return state
    const next = new Map(state)
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const targetId = event.target.startsWith('plan:') ? event.target.slice('plan:'.length) : event.target

    if (event.type === 'plan.create') {
      const item = revive({
        id: targetId === 'new' ? (payload.id as string) || `plan-${event.at}-${event.seq}` : targetId,
        title: payload.title,
        note: payload.note,
        project: payload.project,
        day: payload.day,
        time: payload.time,
        attachments: normalizeAttachments(payload.attachments),
        done: false,
        createdBy: event.actorId,
        order: Number(payload.order) || 0,
        createdAt: event.at,
        updatedAt: event.at,
        version: event.version ?? 1
      })
      if (item) next.set(item.id, item)
    } else if (event.type === 'plan.update') {
      const existing = next.get(targetId)
      if (existing) {
        const updated: PlanItem = {
          ...existing,
          title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 200) : existing.title,
          note: typeof payload.note === 'string' ? payload.note.slice(0, 4_000) : existing.note,
          project: payload.project !== undefined ? (payload.project === null ? undefined : normalizeProject(payload.project)) : existing.project,
          day: payload.day !== undefined ? (payload.day === null ? undefined : normalizeDay(payload.day)) : existing.day,
          time: payload.time !== undefined ? (payload.time === null ? undefined : normalizeTime(payload.time)) : existing.time,
          done: typeof payload.done === 'boolean' ? payload.done : existing.done,
          order: typeof payload.order === 'number' && Number.isFinite(payload.order) ? payload.order : existing.order,
          attachments:
            payload.attachments !== undefined
              ? normalizeAttachments(payload.attachments)
              : existing.attachments,
          updatedAt: event.at,
          version: event.version ?? existing.version + 1
        }

        if (updated.attachments && updated.attachments.length === 0) delete (updated as Partial<PlanItem>).attachments
        next.set(targetId, updated)
      }
    } else if (event.type === 'plan.toggle') {
      const existing = next.get(targetId)
      if (existing) {
        const done = typeof payload.done === 'boolean' ? payload.done : !existing.done
        next.set(targetId, {
          ...existing,
          done,
          updatedAt: event.at,
          version: event.version ?? existing.version + 1
        })
      }
    } else if (event.type === 'plan.delete') {
      next.delete(targetId)
    }

    return next
  }




  applyEvent(event: JournalEntry): void {
    if (event.phase !== 'commit') return
    const nextMap = PlannerStore.reduce(this.items, event)
    this.items.clear()
    for (const [k, v] of nextMap.entries()) {
      this.items.set(k, v)
    }
    if (typeof event.version === 'number' && event.target.startsWith('plan:')) {
      const id = event.target.slice('plan:'.length)
      if (event.type === 'plan.delete') {
        this.versions.forget(id)
      } else {
        this.versions.seed([{ id, version: event.version }])
      }
    }
    if (event.seq > this.snapshotSeq) {
      this.snapshotSeq = event.seq
    }
    this.eventsSinceSnapshot += 1
    if (this.eventsSinceSnapshot >= PLANNER_SNAPSHOT_INTERVAL) {
      this.flushAsync()
    }
  }




  foldEvents(events: Iterable<JournalEntry>, initialState: PlannerState = new Map()): PlannerState {
    return fold(events, PlannerStore.reduce, initialState)
  }



  private ensure(tailEvents?: JournalEntry[]): void {
    if (this.loaded) return


    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    this.loaded = true
    const schemaVersion = Number(raw.schemaVersion)
    if (Number.isFinite(schemaVersion) && schemaVersion > PLANNER_SCHEMA_VERSION) {
      console.warn(`planner store schema v${schemaVersion} is newer than supported v${PLANNER_SCHEMA_VERSION}; loading best-effort`)
    }
    const items = Array.isArray(raw.items) ? raw.items : []
    for (const entry of items) {
      const item = revive(entry)
      if (item) this.items.set(item.id, item)
    }
    this.snapshotSeq = Number(raw.snapshotSeq) || 0
    this.versions.seed(this.items.values())


    if (tailEvents && tailEvents.length > 0) {
      const tailToApply = tailEvents.filter((e) => e.seq > this.snapshotSeq && e.phase === 'commit')
      if (tailToApply.length > 0) {
        const replayed = this.foldEvents(tailToApply, this.items)
        this.items.clear()
        for (const [k, v] of replayed.entries()) {
          this.items.set(k, v)
        }
        this.versions.seed(this.items.values())
        this.snapshotSeq = Math.max(this.snapshotSeq, ...tailToApply.map((e) => e.seq))
      }
    }
  }

  loadWithTail(tailEvents: JournalEntry[]): void {
    this.loaded = false
    this.items.clear()
    this.ensure(tailEvents)
  }

  snapshot(): PlannerSnapshot {
    this.ensure()
    return {
      snapshotSeq: this.snapshotSeq,
      schemaVersion: PLANNER_SCHEMA_VERSION,
      items: this.list()
    }
  }



  rewind(targetSeq: number, events: Iterable<JournalEntry> = []): PlanItem[] {
    this.ensure()
    const rewoundMap = rewindHelper(
      targetSeq,
      events,
      PlannerStore.reduce,
      { snapshotSeq: 0, state: new Map<string, PlanItem>() }
    )
    return Array.from(rewoundMap.values()).sort(sortPlanItems)
  }

  blame(target: ResourceId, events: Iterable<JournalEntry> = []): JournalEntry[] {
    return blameHelper(target, events)
  }

  replay(events: Iterable<JournalEntry>, fromState?: PlannerState): PlanItem[] {
    const state = fold(events, PlannerStore.reduce, fromState ?? new Map())
    return Array.from(state.values()).sort(sortPlanItems)
  }

  fork(forkId: string, atSeq?: number, events?: Iterable<JournalEntry>): PlanItem[] {
    this.ensure()
    if (typeof atSeq === 'number' && events) {
      return this.rewind(atSeq, events)
    }
    const forkedMap = forkHelper(forkId, this.items)
    return Array.from(forkedMap.values()).sort(sortPlanItems)
  }



  private changed(): void {
    this.emit('change', this.list())
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushAsync()
    }, 250)
    this.persistTimer.unref?.()
  }

  private payloadForPersist(): Record<string, unknown> {
    return {
      snapshotSeq: this.snapshotSeq,
      schemaVersion: PLANNER_SCHEMA_VERSION,
      items: Array.from(this.items.values())
    }
  }


  private flush(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.loaded) return
    try {
      writeJsonAtomic(this.file, this.payloadForPersist())
      this.syncFlushedSeq = this.writeSeq
      this.eventsSinceSnapshot = 0
    } catch (err) {
      console.error('failed to persist planner', err)
      notifyPersistError('planner', err)
    }
  }







  private flushAsync(): void {
    if (!this.loaded) return
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.payloadForPersist()
    this.writeChain = this.writeChain
      .catch(() => {

      })
      .then(async () => {
        if (seq <= this.syncFlushedSeq) return
        try {
          await writeJsonAtomicAsync(this.file, snapshot)
        } catch (err) {
          console.error('failed to persist planner', err)
          notifyPersistError('planner', err)
          return
        }
        if (seq <= this.syncFlushedSeq) {
          try {
            writeJsonAtomic(this.file, this.payloadForPersist())
            this.syncFlushedSeq = this.writeSeq
          } catch (err) {
            console.error('failed to persist planner', err)
            notifyPersistError('planner', err)
          }
        } else {
          this.eventsSinceSnapshot = 0
        }
      })
      .catch((err) => {
        console.error('planner flushAsync chain broke', err)
        notifyPersistError('planner', err)
      })
  }

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

  get(id: string, overlayId?: string): PlanItem | undefined {
    this.ensure()
    const item = this.items.get(id)
    if (!item || !overlayId || !this.versions.hasOverlay(overlayId)) return item
    return { ...item, version: this.versions.current(id, overlayId) }
  }

  list(overlayId?: string): PlanItem[] {
    this.ensure()
    const items = Array.from(this.items.values())
    if (overlayId && this.versions.hasOverlay(overlayId)) {
      return items.map((it) => ({ ...it, version: this.versions.current(it.id, overlayId) })).sort(sortPlanItems)
    }
    return items.sort(sortPlanItems)
  }

  createItem(input: {
    id?: string
    title?: string
    note?: string
    project?: string
    day?: string
    time?: string
    attachments?: string[]
    createdBy: string
    done?: boolean
  }, overlayId?: string): PlanItem {
    this.ensure()
    const title = input.title?.trim().slice(0, 200)
    if (!title) throw new CommandError('invalid', 'title is required')
    const day = normalizeDay(input.day)
    const now = Date.now()
    const id = (typeof input.id === 'string' && input.id.trim()) ? input.id.trim() : this.nextId()
    const attachments = normalizeAttachments(input.attachments)
    const item: PlanItem = {
      id,
      title,
      note: typeof input.note === 'string' ? input.note.slice(0, 4_000) : '',
      project: normalizeProject(input.project),
      day,
      time: normalizeTime(input.time),
      done: input.done === true,
      createdBy: input.createdBy,
      order: this.nextOrder(day),
      createdAt: now,
      updatedAt: now,
      version: this.versions.bump(id, overlayId),
      ...(attachments && attachments.length ? { attachments } : {})
    }
    this.items.set(id, item)
    this.eventsSinceSnapshot += 1
    this.changed()
    return item
  }

  updateItem(
    id: string,
    patch: {
      title?: string
      note?: string
      project?: string | null
      day?: string | null
      time?: string | null
      done?: boolean
      order?: number
      attachments?: string[] | null
    },
    overlayId?: string
  ): PlanItem {
    this.ensure()
    const item = this.items.get(id)
    if (!item) throw new CommandError('not_found', 'plan item not found')
    if (typeof patch.title === 'string' && patch.title.trim()) item.title = patch.title.trim().slice(0, 200)
    if (typeof patch.note === 'string') item.note = patch.note.slice(0, 4_000)
    if (patch.project !== undefined) {
      item.project = patch.project === null ? undefined : normalizeProject(patch.project)
    }
    if (patch.day !== undefined) {
      item.day = patch.day === null ? undefined : normalizeDay(patch.day)
    }
    if (patch.time !== undefined) {
      item.time = patch.time === null ? undefined : normalizeTime(patch.time)
    }
    if (typeof patch.done === 'boolean') item.done = patch.done
    if (typeof patch.order === 'number' && Number.isFinite(patch.order)) item.order = patch.order
    if (patch.attachments !== undefined) {
      const attachments = normalizeAttachments(patch.attachments)
      if (attachments && attachments.length) item.attachments = attachments
      else delete (item as Partial<PlanItem>).attachments
    }
    item.updatedAt = Date.now()
    item.version = this.versions.bump(id, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
    return item
  }

  toggleItem(id: string, done?: boolean, overlayId?: string): PlanItem {
    this.ensure()
    const item = this.items.get(id)
    if (!item) throw new CommandError('not_found', 'plan item not found')
    return this.updateItem(id, { done: typeof done === 'boolean' ? done : !item.done }, overlayId)
  }

  deleteItem(id: string, overlayId?: string): void {
    this.ensure()
    if (!this.items.has(id)) return
    this.items.delete(id)
    this.versions.forget(id, overlayId)
    this.eventsSinceSnapshot += 1
    this.changed()
  }
}

function sortPlanItems(a: PlanItem, b: PlanItem): number {
  const day = (a.day ?? '').localeCompare(b.day ?? '')
  if (day !== 0) return a.day ? (b.day ? day : -1) : b.day ? 1 : 0
  return a.order - b.order
}


function localDayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftLocalDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d, 12, 0, 0)
  date.setDate(date.getDate() + delta)
  return localDayKey(date)
}

function normalizeDay(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new CommandError('invalid', 'day must be YYYY-MM-DD')
  const raw = value.trim()
  if (!raw) return undefined
  const lower = raw.toLowerCase()
  if (lower === 'today') return localDayKey()
  if (lower === 'tomorrow') return shiftLocalDay(localDayKey(), 1)
  if (lower === 'yesterday') return shiftLocalDay(localDayKey(), -1)
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  if (!match) throw new CommandError('invalid', `day "${raw}" is not YYYY-MM-DD`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new CommandError('invalid', `day "${raw}" is not a real date`)
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? value : undefined
}


function safeDay(value: unknown): string | undefined {
  try {
    return normalizeDay(value)
  } catch {
    return undefined
  }
}

function safeTime(value: unknown): string | undefined {
  try {
    return normalizeTime(value)
  } catch {
    return undefined
  }
}

function revive(entry: unknown): PlanItem | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null
  const now = Date.now()
  const attachments = normalizeAttachments(raw.attachments) ?? normalizeAttachments(raw.image ? [raw.image] : undefined)
  return {
    id,
    title,
    note: typeof raw.note === 'string' ? raw.note : '',
    project: normalizeProject(raw.project),
    day: safeDay(raw.day),
    time: safeTime(raw.time),
    done: raw.done === true,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : 'user',
    order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    version: Number(raw.version) > 0 ? Number(raw.version) : 1,
    ...(attachments && attachments.length ? { attachments } : {})
  }
}

function normalizeProject(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const next = value.trim().slice(0, 80)
  return next || undefined
}

function normalizeAttachments(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue

    if (trimmed.length > 1024) continue
    out.push(trimmed.slice(0, 1024))
    if (out.length >= 12) break
  }
  return out.length ? out : undefined
}
