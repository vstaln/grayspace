import * as electron from 'electron'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import type { LinkSyntax } from './appState.ts'
import { backupPath, readStoreJson, writeTextAtomic } from './storage.ts'
import { getUserDataDir } from './userData.ts'
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

const electronApp = (electron as unknown as { app?: { isPackaged?: boolean } }).app

export interface BrainNote {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  projectDir?: string
  /** Freeform grouping label; notes with no folder sit at the top level. */
  folder?: string
  /** Accent colour (`#rrggbb`), shown on the note and its graph node. */
  color?: string
  /** Ids this note points at. Derived from the body on every write. */
  links?: string[]
  /** [[Targets]] with no matching note yet — the editor offers to create them. */
  unresolved?: string[]
  /** Set while the note sits in the trash; cleared on restore. */
  deletedAt?: number
  /** Optimistic-concurrency version, owned by the Command Bus. */
  version: number
}
export interface BrainSnapshot { notes: BrainNote[] }

export interface ReindexInput {
  id: string
  title: string
  content: string
  alive: boolean
}

export interface ReindexOutput {
  id: string
  links: string[]
  unresolved: string[]
}

/** `[[Note title]]` anywhere in the body, including mid-sentence. */
const WIKI_LINK = /\[\[([^\][\n]+)\]\]/g

const norm = (value: string): string => value.trim().toLowerCase()

const moduleDir = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url))

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** Rejects anything that isn't a plain `#rrggbb` hex colour. */
function sanitizeColor(value: unknown): string | undefined {
  const str = String(value ?? '').trim()
  return HEX_COLOR.test(str) ? str.toLowerCase() : undefined
}

/** Trashed notes are kept this long before being purged for good. */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const userDataPath = (): string => getUserDataDir()

type NativeBrainCore = {
  reindexNotes(notes: ReindexInput[], syntax: string): ReindexOutput[]
}

const nativeBrainCore = (() => {
  try {
    const require = createRequire(import.meta.url)
    const nativeDir = electronApp?.isPackaged
      ? join(process.resourcesPath, 'native', 'brain-core')
      : join(moduleDir, '../../native/brain-core')
    return require(nativeDir) as NativeBrainCore
  } catch (error) {
    console.warn('[native] brain-core unavailable; using the TypeScript brain reindex fallback.', error)
    return null
  }
})()

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
}

function noteFilename(note: Pick<BrainNote, 'title' | 'id'>): string {
  return `${slug(note.title)}-${note.id.slice(-8)}.md`
}

function frontmatterValue(key: string, value: unknown): string {
  if (value === null || typeof value === 'number') return `${key}: ${value}`
  return `${key}: ${JSON.stringify(value)}`
}

function serializeNote(note: BrainNote): string {
  const lines = [
    '---',
    frontmatterValue('id', note.id),
    frontmatterValue('title', note.title),
    frontmatterValue('tags', note.tags),
    frontmatterValue('folder', note.folder ?? null),
    frontmatterValue('color', note.color ?? null),
    frontmatterValue('projectDir', note.projectDir ?? null),
    frontmatterValue('createdAt', note.createdAt),
    frontmatterValue('updatedAt', note.updatedAt),
    frontmatterValue('deletedAt', note.deletedAt ?? null),
    frontmatterValue('version', note.version),
    '---',
    ''
  ]
  return `${lines.join('\n')}${note.content}`
}

function parseNote(rawText: string): BrainNote {
  const text = rawText.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) throw new Error('missing frontmatter')
  const boundary = text.indexOf('\n---\n', 4)
  if (boundary < 0) throw new Error('missing frontmatter boundary')
  const values: Record<string, unknown> = {}
  for (const line of text.slice(4, boundary).split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`invalid frontmatter line: ${line}`)
    const key = line.slice(0, separator)
    const rest = line.slice(separator + 1).trim()
    if (rest === 'null') values[key] = null
    else if (rest.startsWith('"') || rest.startsWith('[')) values[key] = JSON.parse(rest)
    else values[key] = Number(rest)
  }
  const note = values as Partial<BrainNote>
  if (typeof note.id !== 'string' || typeof note.title !== 'string') throw new Error('missing note id or title')
  if (!Array.isArray(note.tags) || typeof note.createdAt !== 'number' || typeof note.updatedAt !== 'number' || typeof note.version !== 'number')
    throw new Error('missing note fields')
  return {
    id: note.id,
    title: note.title,
    content: text.slice(boundary + 5),
    tags: note.tags.map(String),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    projectDir: typeof note.projectDir === 'string' ? note.projectDir : undefined,
    folder: typeof note.folder === 'string' ? note.folder : undefined,
    color: typeof note.color === 'string' ? note.color : undefined,
    deletedAt: typeof note.deletedAt === 'number' ? note.deletedAt : undefined,
    version: note.version
  }
}

/**
 * Pulls `[[targets]]` out of a body. The `$Note title` form has no closing
 * delimiter, so it cannot be tokenised blindly — it is resolved against known
 * titles in `reindex` instead.
 */
export function parseWikiLinks(content: string): string[] {
  const out = new Set<string>()
  for (const match of String(content || '').matchAll(WIKI_LINK)) {
    // `[[Title|alias]]` — only the part before the pipe addresses a note.
    const target = match[1].split('|')[0].trim()
    if (target) out.add(target)
  }
  return Array.from(out)
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/**
 * `$Title` on both word boundaries, anywhere in the body.
 *
 * Built as a regex rather than an `indexOf` scan on purpose: lowercasing and
 * trimming the haystack first shifts every index, so a boundary check against
 * the original string reads the wrong character — and a plain `indexOf` gives
 * up after the first hit even when a later occurrence is a valid link.
 */
function dollarLinkPattern(title: string): RegExp | null {
  const target = title.trim()
  if (!target) return null
  return new RegExp(`(?<![\\p{L}\\p{N}])\\$${target.replace(REGEX_SPECIALS, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')
}

export function reindexJs(notes: ReindexInput[], syntax: LinkSyntax): ReindexOutput[] {
  const alive = notes.filter(note => note.alive)
  const byTitle = new Map<string, string>()
  for (const note of alive) byTitle.set(norm(note.title), note.id)

  const dollarPatterns =
    syntax === 'wiki'
      ? []
      : alive
          .map(note => ({ id: note.id, pattern: dollarLinkPattern(note.title) }))
          .filter((entry): entry is { id: string; pattern: RegExp } => entry.pattern !== null)

  return notes.map(note => {
    const links = new Set<string>()
    const unresolved: string[] = []

    if (syntax === 'wiki' || syntax === 'both')
      for (const target of parseWikiLinks(note.content)) {
        const id = byTitle.get(norm(target))
        if (id && id !== note.id) links.add(id)
        else if (!id && !unresolved.includes(target)) unresolved.push(target)
      }

    if (dollarPatterns.length && note.content.includes('$'))
      for (const { id, pattern } of dollarPatterns)
        if (id !== note.id && pattern.test(note.content)) links.add(id)

    return { id: note.id, links: Array.from(links), unresolved }
  })
}

export function reindexNative(notes: ReindexInput[], syntax: LinkSyntax): ReindexOutput[] | null {
  if (!nativeBrainCore) return null
  try {
    return nativeBrainCore.reindexNotes(notes, syntax)
  } catch (error) {
    console.warn('[native] brain-core call failed; using the TypeScript brain reindex fallback.', error)
    return null
  }
}

/** Small, portable JSON knowledge base. Kept outside project folders so one brain spans projects. */
export class BrainStore extends EventEmitter {
  private readonly syntax: () => LinkSyntax
  private notes: BrainNote[] = []
  private loaded = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = new Set<string>()
  private purged = new Map<string, string | undefined>()
  private filenames = new Map<string, string>()
  private snapshotSeq = 0
  private eventsSinceSnapshot = 0
  // Bumped by `reindex()`, which every note-mutating method already funnels
  // through — a single invalidation point for the trigram search index below,
  // instead of one more thing every create/update/restore/purge has to
  // remember to touch by hand.
  private searchIndexGeneration = 0
  private searchIndex: { generation: number; trigrams: Map<string, Set<string>> } | null = null
  /** Note versions, kept in step with the Command Bus. */
  readonly versions = new VersionRegistry('note')
  private get file(): string { return join(userDataPath(), 'second-brain.json') }
  private get notesDir(): string { return join(userDataPath(), 'notes') }

  /** `syntax` is read live so flipping the setting re-links notes without a restart. */
  constructor(syntax: () => LinkSyntax = () => 'both') {
    super()
    this.syntax = syntax
  }

  // ---- Event sourcing: Reducer --------------------------------------------

  /**
   * Pure state reduction: state = reduce(state, event).
   */
  static reduce(notes: BrainNote[], event: JournalEntry): BrainNote[] {
    if (event.phase !== 'commit') return notes
    const next = notes.map((n) => ({ ...n, tags: [...n.tags] }))
    const payload = (event.payload ?? {}) as Record<string, unknown>
    const targetId = event.target.startsWith('note:') ? event.target.slice('note:'.length) : event.target

    if (event.type === 'note.create') {
      const title = String(payload.title || '').trim().slice(0, 200) || 'Untitled Note'
      const note: BrainNote = {
        id: targetId === 'new' ? (payload.id as string) || `note-${event.at}-${event.seq}` : targetId,
        title,
        content: String(payload.content || '').slice(0, 200_000),
        tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
        projectDir: typeof payload.projectDir === 'string' ? payload.projectDir : undefined,
        folder: typeof payload.folder === 'string' ? payload.folder.trim() || undefined : undefined,
        color: sanitizeColor(payload.color),
        createdAt: event.at,
        updatedAt: event.at,
        version: event.version ?? 1
      }
      next.push(note)
    } else if (event.type === 'note.update') {
      const idx = next.findIndex((n) => n.id === targetId)
      if (idx >= 0) {
        const note = next[idx]
        if (payload.title !== undefined) note.title = String(payload.title).trim().slice(0, 200) || note.title
        if (payload.content !== undefined) note.content = String(payload.content).slice(0, 200_000)
        if (Array.isArray(payload.tags)) note.tags = payload.tags.map(String)
        if (payload.projectDir !== undefined) note.projectDir = (payload.projectDir as string) || undefined
        if (payload.folder !== undefined) note.folder = String(payload.folder).trim() || undefined
        if (payload.color !== undefined) note.color = sanitizeColor(payload.color)
        note.updatedAt = event.at
        note.version = event.version ?? note.version + 1
      }
    } else if (event.type === 'note.delete') {
      const note = next.find((n) => n.id === targetId)
      if (note) {
        note.deletedAt = event.at
        note.version = event.version ?? note.version + 1
      }
    } else if (event.type === 'note.restore') {
      const note = next.find((n) => n.id === targetId)
      if (note) {
        note.deletedAt = undefined
        note.updatedAt = event.at
        note.version = event.version ?? note.version + 1
      }
    } else if (event.type === 'note.purge') {
      const filtered = next.filter((n) => n.id !== targetId)
      return filtered
    }

    return next
  }

  applyEvent(event: JournalEntry): void {
    if (event.phase !== 'commit') return
    this.notes = BrainStore.reduce(this.notes, event)
    if (typeof event.version === 'number' && event.target.startsWith('note:')) {
      const id = event.target.slice('note:'.length)
      if (event.type === 'note.purge') {
        this.versions.forget(id)
      } else {
        this.versions.seed([{ id, version: event.version }])
      }
    }
    if (event.seq > this.snapshotSeq) {
      this.snapshotSeq = event.seq
    }
    this.eventsSinceSnapshot += 1
  }

  foldEvents(events: Iterable<JournalEntry>, initial: BrainNote[] = []): BrainNote[] {
    return fold(events, BrainStore.reduce, initial)
  }

  loadWithTail(tailEvents: JournalEntry[]): void {
    this.loaded = false
    this.load()
    if (tailEvents.length > 0) {
      const tailToApply = tailEvents.filter((e) => e.seq > this.snapshotSeq && e.phase === 'commit')
      if (tailToApply.length > 0) {
        this.notes = this.foldEvents(tailToApply, this.notes)
        this.versions.seed(this.notes)
        this.snapshotSeq = Math.max(this.snapshotSeq, ...tailToApply.map((e) => e.seq))
      }
    }
  }

  // ---- Event Sourcing Free Features: rewind, blame, replay, fork -----------

  rewind(targetSeq: number, events: Iterable<JournalEntry> = []): BrainNote[] {
    this.ensure()
    return rewindHelper(
      targetSeq,
      events,
      BrainStore.reduce,
      { snapshotSeq: 0, state: [] as BrainNote[] }
    ).filter((n) => !n.deletedAt)
  }

  blame(target: ResourceId, events: Iterable<JournalEntry> = []): JournalEntry[] {
    return blameHelper(target, events)
  }

  replay(events: Iterable<JournalEntry>, fromState?: BrainNote[]): BrainNote[] {
    return fold(events, BrainStore.reduce, fromState ?? []).filter((n) => !n.deletedAt)
  }

  fork(forkId: string, atSeq?: number, events?: Iterable<JournalEntry>): BrainNote[] {
    this.ensure()
    if (typeof atSeq === 'number' && events) {
      return this.rewind(atSeq, events)
    }
    return forkHelper(forkId, this.notes).filter((n) => !n.deletedAt)
  }

  private changed(): void {
    this.emit('change', this.snapshot())
  }

  snapshot(overlayId?: string): BrainSnapshot {
    this.ensure()
    const alive = this.notes.filter((n) => !n.deletedAt)
    const notes = overlayId && this.versions.hasOverlay(overlayId)
      ? alive.map((n) => ({ ...n, version: this.versions.current(n.id, overlayId) }))
      : alive
    return {
      notes: notes.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }

  /**
   * One alive note by id, or null. Note widgets used to call `list()` — the
   * whole brain, every full content — to find a single note, once per widget
   * mount and once per retry; with a dozen note widgets on the canvas that
   * serialized the entire store over IPC a dozen times for one record each.
   */
  get(id: string): BrainNote | null {
    this.ensure()
    const note = this.notes.find(n => n.id === id && !n.deletedAt)
    return note ?? null
  }

  create(input: Partial<BrainNote>): BrainNote {
    this.ensure()
    const now = Date.now()
    const title = String(input.title || '').trim().slice(0, 200)
    if (!title) throw new CommandError('invalid', 'note title is required')
    const note: BrainNote = {
      id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      content: String(input.content || '').slice(0, 200_000),
      tags: this.tags(input.tags),
      projectDir: input.projectDir,
      folder: input.folder?.trim() || undefined,
      color: sanitizeColor(input.color),
      createdAt: now,
      updatedAt: now,
      version: 0
    }
    note.version = this.versions.bump(note.id)
    this.notes.push(note)
    for (const id of this.reindex()) this.dirty.add(id)
    this.dirty.add(note.id)
    this.save()
    this.changed()
    return note
  }

  update(id: string, patch: Partial<BrainNote>): BrainNote {
    this.ensure()
    const note = this.notes.find(n => n.id === id)
    if (!note) throw new CommandError('not_found', 'note not found')
    if (
      patch.title === undefined &&
      patch.content === undefined &&
      patch.tags === undefined &&
      patch.projectDir === undefined &&
      patch.folder === undefined &&
      patch.color === undefined
    ) {
      // A no-op patch would silently "succeed" without changing anything.
      throw new CommandError('invalid', 'nothing to update')
    }
    // An emptied title stays emptied: the old `|| note.title` fallback silently
    // resurrected the previous text right after the user cleared the field —
    // the debounced save round-tripped, the store kept the old value, and the
    // next broadcast snapped "New Note" back into the input. Lists render
    // "Untitled" for a blank title (SecondBrain already does), so empty is a
    // legitimate state, not a gap to paper over.
    if (patch.title !== undefined) note.title = String(patch.title).trim().slice(0, 200)
    if (patch.content !== undefined) note.content = String(patch.content).slice(0, 200_000)
    if (patch.tags !== undefined) note.tags = this.tags(patch.tags)
    if (patch.projectDir !== undefined) note.projectDir = patch.projectDir || undefined
    if (patch.folder !== undefined) note.folder = String(patch.folder).trim() || undefined
    if (patch.color !== undefined) note.color = sanitizeColor(patch.color)
    note.updatedAt = Date.now()
    note.version = this.versions.bump(note.id)
    // A renamed title rewires every note pointing at it, so reindex globally.
    for (const id of this.reindex()) this.dirty.add(id)
    this.dirty.add(note.id)
    this.save()
    this.changed()
    return note
  }

  /** Soft-deletes: the note moves to the trash (restore-able) instead of vanishing. */
  remove(id: string): void {
    this.ensure()
    const note = this.notes.find(n => n.id === id)
    if (!note) throw new CommandError('not_found', 'note not found')
    note.deletedAt = Date.now()
    note.version = this.versions.bump(note.id)
    for (const id of this.reindex()) this.dirty.add(id)
    this.save()
    this.changed()
  }

  /** Notes in the trash, newest first. */
  trash(): BrainNote[] {
    this.ensure()
    return this.notes
      .filter(n => n.deletedAt)
      .slice()
      .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
  }

  /** Puts a trashed note back; its links are re-derived on the next reindex. */
  restore(id: string): BrainNote {
    this.ensure()
    const note = this.notes.find(n => n.id === id && n.deletedAt)
    if (!note) throw new CommandError('not_found', 'note not found')
    note.deletedAt = undefined
    note.updatedAt = Date.now()
    note.version = this.versions.bump(note.id)
    for (const id of this.reindex()) this.dirty.add(id)
    this.save()
    this.changed()
    return note
  }

  /** Permanent deletion — the only path out of the trash. */
  purge(id: string): void {
    this.ensure()
    const note = this.notes.find(n => n.id === id)
    if (!note) throw new CommandError('not_found', 'note not found')
    this.notes = this.notes.filter(n => n.id !== id)
    this.versions.forget(id)
    for (const id of this.reindex()) this.dirty.add(id)
    this.dirty.delete(id)
    this.purged.set(id, this.filenames.get(id))
    this.save()
    this.changed()
  }

  /**
   * A note's searchable text is its title, content and tags joined; matching
   * mirrors what the old plain `.includes(q)` scan did exactly, so this stays
   * a drop-in swap — only the candidate set fed into it changed (PERF-search).
   */
  private static haystack(n: BrainNote): string {
    return `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase()
  }

  /**
   * Maps every 3-character run appearing anywhere in a note's text to that
   * note's id. A query's own trigrams intersected against this index give the
   * set of notes that could possibly contain it as a substring — any note
   * missing even one of the query's trigrams cannot contain the query, full
   * stop, so the intersection can only ever be too large, never too small.
   * The final `.includes(q)` below is what turns "could possibly contain"
   * into "does contain", so results are byte-identical to a full linear scan.
   */
  private buildSearchIndex(): Map<string, Set<string>> {
    const trigrams = new Map<string, Set<string>>()
    for (const note of this.notes) {
      if (note.deletedAt) continue
      const text = BrainStore.haystack(note)
      const seen = new Set<string>()
      for (let i = 0; i <= text.length - 3; i += 1) {
        const gram = text.slice(i, i + 3)
        if (seen.has(gram)) continue
        seen.add(gram)
        let ids = trigrams.get(gram)
        if (!ids) {
          ids = new Set()
          trigrams.set(gram, ids)
        }
        ids.add(note.id)
      }
    }
    return trigrams
  }

  search(query = ''): BrainNote[] {
    this.ensure()
    const q = norm(query)
    const notes = this.snapshot().notes
    if (!q) return notes
    // A query shorter than a trigram can't be looked up in the index at all
    // (there's no 3-char slice to take), and at that length almost every note
    // matches anyway — a full scan here costs about what building the index
    // would (PERF-search).
    if (q.length < 3) return notes.filter((n) => BrainStore.haystack(n).includes(q))

    if (!this.searchIndex || this.searchIndex.generation !== this.searchIndexGeneration) {
      this.searchIndex = { generation: this.searchIndexGeneration, trigrams: this.buildSearchIndex() }
    }
    const trigrams = this.searchIndex.trigrams

    let candidates: Set<string> | null = null
    for (let i = 0; i <= q.length - 3; i += 1) {
      const ids = trigrams.get(q.slice(i, i + 3))
      // This trigram of the query appears in no note's text at all, so no
      // note can contain the whole query as a substring either.
      if (!ids || ids.size === 0) return []
      if (!candidates) {
        candidates = ids
      } else {
        const next = new Set<string>()
        for (const id of candidates) if (ids.has(id)) next.add(id)
        candidates = next
      }
      if (candidates.size === 0) return []
    }

    return notes.filter((n) => candidates!.has(n.id) && BrainStore.haystack(n).includes(q))
  }

  /** Notes linking *to* `id` — the incoming half of a bidirectional link. */
  backlinks(id: string): BrainNote[] {
    this.ensure()
    return this.notes.filter(n => !n.deletedAt && (n.links || []).includes(id))
  }

  /** Recomputes links after the link-syntax setting changes. */
  refresh(): void {
    this.ensure()
    for (const id of this.reindex()) this.dirty.add(id)
    this.save()
    this.changed()
  }


  /** Rebuilds `links`/`unresolved` for every note under the active syntax. */
  private reindex(): Set<string> {
    const syntax = this.syntax()
    const input: ReindexInput[] = this.notes.map(n => ({
      id: n.id,
      title: n.title,
      content: n.content,
      alive: !n.deletedAt
    }))
    const results = reindexNative(input, syntax) ?? reindexJs(input, syntax)
    const byId = new Map(results.map(result => [result.id, result]))
    const changed = new Set<string>()
    for (const note of this.notes) {
      const result = byId.get(note.id)
      const links = result?.links ?? []
      const unresolved = result?.unresolved ?? []
      if (JSON.stringify(note.links ?? []) !== JSON.stringify(links) || JSON.stringify(note.unresolved ?? []) !== JSON.stringify(unresolved)) {
        changed.add(note.id)
      }
      note.links = links
      note.unresolved = unresolved
    }
    this.searchIndexGeneration += 1
    return changed
  }

  private tags(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean).slice(0, 20) : []
  }

  private ensure(): void {
    if (!this.loaded) this.load()
  }

  private load(): void {
    // Loaded is only flagged once the read succeeded: a transient EBUSY/EACCES
    // (antivirus lock) must not leave an empty brain for the whole session.
    const raw = this.readNotes()
    this.loaded = true
    // A note without a usable title would crash `reindex` (norm(undefined)) and
    // take the whole brain down with it — drop malformed entries loudly.
    this.notes = raw.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string')
    const skipped = raw.length - this.notes.length
    if (skipped > 0) console.error(`dropped ${skipped} malformed note(s) without a title from ${this.file}`)
    // Notes whose trash stay has expired are dropped for good, silently.
    const cutoff = Date.now() - TRASH_TTL_MS
    const before = this.notes.length
    this.notes = this.notes.filter(n => !n.deletedAt || n.deletedAt > cutoff)
    if (this.notes.length !== before) {
      for (const note of raw) if (!this.notes.includes(note)) this.deleteNoteFile(note.id)
    }
    // A note written before versions existed starts at 1, not 0, so a client
    // that has read it can send a matching baseVersion straight away.
    for (const note of this.notes) if (!(note.version > 0)) note.version = 1
    this.versions.seed(this.notes)
    this.reindex()
  }

  private readNotes(): BrainNote[] {
    if (!fs.existsSync(this.notesDir)) {
      if (fs.existsSync(this.file)) return this.migrateLegacy()
      return []
    }
    // A previous migration attempt died halfway (disk full, EBUSY): the JSON
    // source is still in place and later saves have already created notesDir,
    // so the plain "notesDir missing" check above would skip it forever and
    // the pre-migration notes would be invisible from every future session.
    // Resume the merge, then fall through and read the resulting directory.
    if (fs.existsSync(`${this.file}.migration-pending`) && fs.existsSync(this.file)) {
      try {
        this.migrateLegacy()
      } catch (err) {
        console.error(`failed to resume second brain migration from ${this.file}`, err)
      }
    }
    let files: string[]
    try {
      files = fs.readdirSync(this.notesDir).filter(file => file.endsWith('.md'))
    } catch (err) {
      console.error(`failed to read notes directory ${this.notesDir}`, err)
      return []
    }
    const byId = new Map<string, { note: BrainNote; filename: string }>()
    const losers: string[] = []
    for (const filename of files) {
      try {
        const note = parseNote(fs.readFileSync(join(this.notesDir, filename), 'utf8'))
        const existing = byId.get(note.id)
        if (!existing) {
          byId.set(note.id, { note, filename })
          continue
        }
        const newer = (note.updatedAt ?? 0) >= (existing.note.updatedAt ?? 0)
        if (newer) {
          losers.push(existing.filename)
          byId.set(note.id, { note, filename })
        } else {
          losers.push(filename)
        }
      } catch (err) {
        console.error(`skipped malformed note file ${join(this.notesDir, filename)}`, err)
      }
    }
    for (const filename of losers) {
      try {
        this.deleteFilename(filename)
      } catch (err) {
        console.error(`failed to drop duplicate note file ${filename}`, err)
      }
    }
    const notes: BrainNote[] = []
    for (const { note, filename } of byId.values()) {
      notes.push(note)
      this.filenames.set(note.id, filename)
    }
    return notes
  }

  private migrateLegacy(): BrainNote[] {
    const data = readStoreJson<Partial<BrainSnapshot>>(this.file, {})
    const raw = Array.isArray(data.notes) ? data.notes : []
    const valid = raw
      .filter(n => n && typeof n.id === 'string' && typeof n.title === 'string')
      .map(n => ({
        ...(n as BrainNote),
        content: typeof n.content === 'string' ? n.content : '',
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
        updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : Date.now(),
        version: typeof n.version === 'number' ? n.version : 1
      })) as BrainNote[]
    const staging = `${this.notesDir}.migrating-${process.pid}-${Date.now()}`
    // Mark the attempt before touching anything: a process killed mid-migration
    // (or a later save() that created notesDir) must not make the next start
    // skip the remaining JSON-only notes forever.
    try { fs.writeFileSync(`${this.file}.migration-pending`, '') } catch { /* best effort */ }
    try {
      fs.mkdirSync(staging, { recursive: true })
      for (const note of valid) writeTextAtomic(join(staging, noteFilename(note)), serializeNote(note))
      if (fs.existsSync(this.notesDir)) {
        // Resume after an earlier partial migration: never clobber a newer .md
        // written since — only fill in the gaps.
        for (const entry of fs.readdirSync(staging)) {
          const target = join(this.notesDir, entry)
          if (!fs.existsSync(target)) fs.renameSync(join(staging, entry), target)
        }
        fs.rmSync(staging, { recursive: true, force: true })
      } else {
        fs.renameSync(staging, this.notesDir)
      }
      fs.renameSync(this.file, `${this.file}.migrated`)
      try { fs.unlinkSync(`${this.file}.migration-pending`) } catch { /* best effort */ }
      for (const note of valid) this.filenames.set(note.id, noteFilename(note))
      return valid
    } catch (err) {
      console.error(`failed to migrate second brain ${this.file}`, err)
      try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
      // Keep serving the JSON notes. Returning [] would let the next save
      // create notesDir and skip this file forever — the pending marker above
      // makes the next start resume instead.
      for (const note of valid) this.filenames.set(note.id, noteFilename(note))
      return valid
    }
  }

  private deleteNoteFile(id: string): void {
    const filename = this.filenames.get(id)
    if (!filename) return
    try { this.deleteFilename(filename) } catch (err) {
      console.error(`failed to purge note file ${filename}`, err)
    }
    this.filenames.delete(id)
  }

  private save(): void {
    // PERF-004: a burst of edits (create + reindex + save per keystroke-batch)
    // collapses into one write; the app flushes pending writes on shutdown.
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 500)
    this.saveTimer.unref?.()
  }

  /** Writes now, cancelling any pending debounce. */
  private flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      for (const [id, filename] of Array.from(this.purged)) {
        if (filename) this.deleteFilename(filename)
          else if (fs.existsSync(this.notesDir)) {
          // Fallback when we never learned the filename. A blind suffix match
          // once deleted an unrelated note sharing the same 8-char tail —
          // only remove files whose frontmatter id really is the purged one.
          const claimedByLiveNotes = new Set<string>()
          for (const note of this.notes) {
            const filename = this.filenames.get(note.id)
            if (filename) claimedByLiveNotes.add(filename)
          }
          for (const candidate of fs.readdirSync(this.notesDir).filter(file => file.endsWith(`-${id.slice(-8)}.md`))) {
            if (claimedByLiveNotes.has(candidate)) continue
            try {
              const parsed = parseNote(fs.readFileSync(join(this.notesDir, candidate), 'utf8'))
              if (parsed.id !== id) continue
            } catch {
              continue
            }
            this.deleteFilename(candidate)
          }
        }
        this.filenames.delete(id)
        this.purged.delete(id)
      }
      for (const id of Array.from(this.dirty)) {
        const note = this.notes.find(entry => entry.id === id)
        if (!note) continue
        const filename = noteFilename(note)
        const oldFilename = this.filenames.get(id)
        writeTextAtomic(join(this.notesDir, filename), serializeNote(note))
        if (oldFilename && oldFilename !== filename) this.deleteFilename(oldFilename)
        this.filenames.set(id, filename)
        this.dirty.delete(id)
      }
    } catch (err) {
      // Losing the write is bad, but taking the app down over it is worse — the
      // in-memory notes stay intact and the next edit retries the write.
      console.error('failed to persist second brain', err)
    }
  }

  private deleteFilename(filename: string): void {
    const path = join(this.notesDir, filename)
    try { fs.unlinkSync(path) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    // writeTextAtomic leaves a `.bak` sibling behind on overwrite (DI-006) — once
    // the note itself is gone (purged or renamed away), that backup is orphaned.
    try { fs.unlinkSync(backupPath(path)) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  /** Flushes any pending write; call from the app's shutdown path. */
  dispose(): void {
    this.flush()
    this.removeAllListeners()
  }
}
