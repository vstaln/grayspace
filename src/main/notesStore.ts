import { EventEmitter } from 'events'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { notifyPersistError } from './persistNotifier.ts'
import { CommandError, VersionRegistry } from './core/index.ts'
import { NOTE_CATEGORY_PALETTE, DEFAULT_NOTE_COLOR } from '../shared/noteColors.ts'

export const NOTES_SCHEMA_VERSION = 1

export interface NoteItem {
  id: string
  title: string
  body: string
  tags: string[]
  category?: string
  /** Always resolved: the note's own color, or its category's shared color, or the default. */
  color: string
  createdBy: string
  order: number
  createdAt: number
  updatedAt: number
  version: number
}

export interface NotesSnapshot {
  schemaVersion: number
  items: NoteItem[]
  /** category name -> hex color, so every note in a category reads as the same color without repeating the choice per note. */
  categoryColors: Record<string, string>
}

/**
 * Notes with tags, an optional category, and a color. A category's color is
 * assigned automatically the first time it's used — the next unused hue in
 * NOTE_CATEGORY_PALETTE, deterministic rather than random — so an agent
 * creating a note via `orc note create --category X` gets a sensible color
 * for free; the widget UI lets the user override any category's color, which
 * then applies to every note already in it.
 *
 * Deliberately simpler than PlannerStore: nothing in this app's command
 * wiring calls PlannerStore's rewind/blame/fork/loadWithTail — the live Map
 * plus VersionRegistry is what the command system actually needs — so this
 * store skips that unused replay machinery rather than copying it.
 */
export class NotesStore extends EventEmitter {
  private readonly items = new Map<string, NoteItem>()
  private readonly categoryColors = new Map<string, string>()
  private counter = 0
  private loaded = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writeSeq = 0
  private syncFlushedSeq = 0
  readonly versions = new VersionRegistry('note')

  private get file(): string {
    return join(getUserDataDir(), 'workspace-notes.json')
  }

  private ensure(): void {
    if (this.loaded) return
    const raw = readStoreJson<Record<string, unknown>>(this.file, {})
    this.loaded = true
    const items = Array.isArray(raw.items) ? raw.items : []
    const colors = raw.categoryColors && typeof raw.categoryColors === 'object' ? (raw.categoryColors as Record<string, unknown>) : {}
    for (const [category, color] of Object.entries(colors)) {
      if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) this.categoryColors.set(category, color)
    }
    for (const entry of items) {
      const item = revive(entry, (category) => this.colorForCategory(category))
      if (item) this.items.set(item.id, item)
    }
    this.versions.seed(this.items.values())
  }

  private colorForCategory(category: string | undefined): string {
    if (!category) return DEFAULT_NOTE_COLOR
    const existing = this.categoryColors.get(category)
    if (existing) return existing
    const color = NOTE_CATEGORY_PALETTE[this.categoryColors.size % NOTE_CATEGORY_PALETTE.length]
    this.categoryColors.set(category, color)
    return color
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
      schemaVersion: NOTES_SCHEMA_VERSION,
      items: Array.from(this.items.values()),
      categoryColors: Object.fromEntries(this.categoryColors)
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
    } catch (err) {
      console.error('failed to persist notes', err)
      notifyPersistError('notes', err)
    }
  }

  private flushAsync(): void {
    if (!this.loaded) return
    this.writeSeq += 1
    const seq = this.writeSeq
    const snapshot = this.payloadForPersist()
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        if (seq <= this.syncFlushedSeq) return
        try {
          // Skip a snapshot superseded while its write was in flight. Without
          // the publication guard, an older write could land after a newer
          // change (or after dispose() synchronously flushed the latest state).
          await writeJsonAtomicAsync(this.file, snapshot, () => seq === this.writeSeq && seq > this.syncFlushedSeq)
          this.syncFlushedSeq = Math.max(this.syncFlushedSeq, seq)
        } catch (err) {
          console.error('failed to persist notes', err)
          notifyPersistError('notes', err)
        }
      })
      .catch((err) => {
        console.error('notes flushAsync chain broke', err)
        notifyPersistError('notes', err)
      })
  }

  dispose(): void {
    this.flush()
  }

  private nextId(): string {
    this.counter += 1
    return `note-${Date.now()}-${this.counter}`
  }

  private nextOrder(): number {
    let max = -1
    for (const item of this.items.values()) max = Math.max(max, item.order)
    return max + 1
  }

  snapshot(): NotesSnapshot {
    this.ensure()
    return { schemaVersion: NOTES_SCHEMA_VERSION, items: this.list(), categoryColors: Object.fromEntries(this.categoryColors) }
  }

  list(): NoteItem[] {
    this.ensure()
    return Array.from(this.items.values()).sort((a, b) => a.order - b.order)
  }

  get(id: string): NoteItem | undefined {
    this.ensure()
    return this.items.get(id)
  }

  createItem(input: {
    id?: string
    title?: string
    body?: string
    tags?: string[]
    category?: string
    color?: string
    createdBy: string
  }): NoteItem {
    this.ensure()
    const title = input.title?.trim().slice(0, 200)
    if (!title) throw new CommandError('invalid', 'title is required')
    const now = Date.now()
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : this.nextId()
    const category = normalizeCategory(input.category)
    const explicitColor = normalizeColor(input.color)
    const color = explicitColor ?? this.colorForCategory(category)
    const item: NoteItem = {
      id,
      title,
      body: typeof input.body === 'string' ? input.body.slice(0, 20_000) : '',
      tags: normalizeTags(input.tags),
      category,
      color,
      createdBy: input.createdBy,
      order: this.nextOrder(),
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
    patch: {
      title?: string
      body?: string
      tags?: string[]
      category?: string | null
      color?: string | null
      order?: number
    }
  ): NoteItem {
    this.ensure()
    const item = this.items.get(id)
    if (!item) throw new CommandError('not_found', 'note not found')
    if (typeof patch.title === 'string' && patch.title.trim()) item.title = patch.title.trim().slice(0, 200)
    if (typeof patch.body === 'string') item.body = patch.body.slice(0, 20_000)
    if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags)
    let categoryChanged = false
    if (patch.category !== undefined) {
      item.category = patch.category === null ? undefined : normalizeCategory(patch.category)
      categoryChanged = true
    }
    if (patch.color !== undefined) {
      const explicit = patch.color === null ? undefined : normalizeColor(patch.color)
      if (explicit) {
        item.color = explicit
        if (item.category) this.categoryColors.set(item.category, explicit)
      } else if (categoryChanged) {
        item.color = this.colorForCategory(item.category)
      }
    } else if (categoryChanged) {
      item.color = this.colorForCategory(item.category)
    }
    if (typeof patch.order === 'number' && Number.isFinite(patch.order)) item.order = patch.order
    item.updatedAt = Date.now()
    item.version = this.versions.bump(id)
    this.changed()
    return item
  }

  /** Recolors every note in a category at once — the override path the Notes widget's swatch picker uses. */
  setCategoryColor(category: string, color: string): void {
    this.ensure()
    const normalizedCategory = normalizeCategory(category)
    const normalizedColor = normalizeColor(color)
    if (!normalizedCategory || !normalizedColor) throw new CommandError('invalid', 'category and a #rrggbb color are required')
    this.categoryColors.set(normalizedCategory, normalizedColor)
    for (const item of this.items.values()) {
      if (item.category === normalizedCategory) {
        item.color = normalizedColor
        item.updatedAt = Date.now()
        item.version = this.versions.bump(item.id)
      }
    }
    this.changed()
  }

  deleteItem(id: string): void {
    this.ensure()
    if (!this.items.has(id)) return
    this.items.delete(id)
    this.versions.forget(id)
    this.changed()
  }
}

function normalizeCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const next = value.trim().slice(0, 60)
  return next || undefined
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : undefined
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().toLowerCase().slice(0, 40)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= 20) break
  }
  return out
}

function revive(entry: unknown, colorForCategory: (category: string | undefined) => string): NoteItem | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!id || !title) return null
  const now = Date.now()
  const category = normalizeCategory(raw.category)
  return {
    id,
    title,
    body: typeof raw.body === 'string' ? raw.body : '',
    tags: normalizeTags(raw.tags),
    category,
    color: normalizeColor(raw.color) ?? colorForCategory(category),
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : 'user',
    order: Number.isFinite(raw.order) ? Number(raw.order) : 0,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    version: Number(raw.version) > 0 ? Number(raw.version) : 1
  }
}
