import { app } from 'electron'
import { join } from 'path'
import type { LinkSyntax } from './appState'
import { readStoreJson, writeJsonAtomic } from './storage'
import { Forbidden } from './coordination'

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
}
export interface BrainSnapshot { notes: BrainNote[] }

export type GraphEdgeKind = 'link' | 'tag'
export interface GraphNode { id: string; title: string; tags: string[]; degree: number; color?: string }
export interface GraphEdge { source: string; target: string; kind: GraphEdgeKind }
export interface BrainGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/** `[[Note title]]` anywhere in the body, including mid-sentence. */
const WIKI_LINK = /\[\[([^\][\n]+)\]\]/g

const norm = (value: string): string => value.trim().toLowerCase()

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** Rejects anything that isn't a plain `#rrggbb` hex colour. */
function sanitizeColor(value: unknown): string | undefined {
  const str = String(value ?? '').trim()
  return HEX_COLOR.test(str) ? str.toLowerCase() : undefined
}

/** Trashed notes are kept this long before being purged for good. */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

/** Small, portable JSON knowledge base. Kept outside project folders so one brain spans projects. */
export class BrainStore {
  private notes: BrainNote[] = []
  private loaded = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private get file(): string { return join(app.getPath('userData'), 'second-brain.json') }

  /** `syntax` is read live so flipping the setting re-links notes without a restart. */
  constructor(private readonly syntax: () => LinkSyntax = () => 'both') {}

  snapshot(): BrainSnapshot {
    this.ensure()
    return {
      notes: this.notes
        .filter(n => !n.deletedAt)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
  }

  create(input: Partial<BrainNote>): BrainNote {
    this.ensure()
    const now = Date.now()
    const title = String(input.title || '').trim()
    if (!title) throw new Forbidden('note title is required', 400)
    const note: BrainNote = {
      id: `note-${now}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      content: String(input.content || ''),
      tags: this.tags(input.tags),
      projectDir: input.projectDir,
      folder: input.folder?.trim() || undefined,
      color: sanitizeColor(input.color),
      createdAt: now,
      updatedAt: now
    }
    this.notes.push(note)
    this.reindex()
    this.save()
    return note
  }

  update(id: string, patch: Partial<BrainNote>): BrainNote {
    this.ensure()
    const note = this.notes.find(n => n.id === id)
    if (!note) throw new Forbidden('note not found', 404)
    if (
      patch.title === undefined &&
      patch.content === undefined &&
      patch.tags === undefined &&
      patch.projectDir === undefined &&
      patch.folder === undefined &&
      patch.color === undefined
    ) {
      // A no-op patch would silently "succeed" without changing anything.
      throw new Forbidden('nothing to update', 400)
    }
    if (patch.title !== undefined) note.title = String(patch.title).trim() || note.title
    if (patch.content !== undefined) note.content = String(patch.content)
    if (patch.tags !== undefined) note.tags = this.tags(patch.tags)
    if (patch.projectDir !== undefined) note.projectDir = patch.projectDir || undefined
    if (patch.folder !== undefined) note.folder = String(patch.folder).trim() || undefined
    if (patch.color !== undefined) note.color = sanitizeColor(patch.color)
    note.updatedAt = Date.now()
    // A renamed title rewires every note pointing at it, so reindex globally.
    this.reindex()
    this.save()
    return note
  }

  /** Soft-deletes: the note moves to the trash (restore-able) instead of vanishing. */
  remove(id: string): void {
    this.ensure()
    const note = this.notes.find(n => n.id === id)
    if (!note) throw new Forbidden('note not found', 404)
    note.deletedAt = Date.now()
    this.reindex()
    this.save()
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
    if (!note) throw new Forbidden('note not found', 404)
    note.deletedAt = undefined
    note.updatedAt = Date.now()
    this.reindex()
    this.save()
    return note
  }

  /** Permanent deletion — the only path out of the trash. */
  purge(id: string): void {
    this.ensure()
    const note = this.notes.find(n => n.id === id)
    if (!note) throw new Forbidden('note not found', 404)
    this.notes = this.notes.filter(n => n.id !== id)
    this.reindex()
    this.save()
  }

  search(query = ''): BrainNote[] {
    const q = norm(query)
    return this.snapshot().notes.filter(
      n => !q || `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase().includes(q)
    )
  }

  /** Notes linking *to* `id` — the incoming half of a bidirectional link. */
  backlinks(id: string): BrainNote[] {
    this.ensure()
    return this.notes.filter(n => !n.deletedAt && (n.links || []).includes(id))
  }

  /** Recomputes links after the link-syntax setting changes. */
  refresh(): void {
    this.ensure()
    this.reindex()
  }

  /**
   * Nodes and edges for the force-directed view. Explicit links are hard edges;
   * a shared tag adds a soft edge so unlinked notes still cluster meaningfully.
   */
  graph(): BrainGraph {
    this.ensure()
    const alive = this.notes.filter(n => !n.deletedAt)
    const degree = new Map<string, number>()
    const edges: GraphEdge[] = []
    const seen = new Set<string>()
    const push = (source: string, target: string, kind: GraphEdgeKind): void => {
      // One edge per unordered pair: A→B plus B→A draws a single line.
      const key = `${[source, target].sort().join('|')}|${kind}`
      if (source === target || seen.has(key)) return
      seen.add(key)
      edges.push({ source, target, kind })
      degree.set(source, (degree.get(source) || 0) + 1)
      degree.set(target, (degree.get(target) || 0) + 1)
    }

    for (const note of alive) for (const target of note.links || []) push(note.id, target, 'link')

    const byTag = new Map<string, string[]>()
    for (const note of alive)
      for (const tag of note.tags) byTag.set(norm(tag), [...(byTag.get(norm(tag)) || []), note.id])
    for (const ids of byTag.values())
      // Chain tag members rather than build a clique: keeps the graph readable.
      if (ids.length > 1 && ids.length <= 12)
        for (let i = 1; i < ids.length; i += 1) push(ids[i - 1], ids[i], 'tag')

    return {
      nodes: alive.map(n => ({ id: n.id, title: n.title, tags: n.tags, degree: degree.get(n.id) || 0, color: n.color })),
      edges
    }
  }

  /** Rebuilds `links`/`unresolved` for every note under the active syntax. */
  private reindex(): void {
    const syntax = this.syntax()
    const alive = this.notes.filter(n => !n.deletedAt)
    const byTitle = new Map<string, string>()
    // Deleted notes neither receive live links nor resolve titles: only the
    // restore path re-runs this, at which point they are alive again.
    for (const note of alive) byTitle.set(norm(note.title), note.id)

    // Compile each title's pattern once for the whole pass instead of once per
    // (note, other) pair — the difference is n vs n² regex compilations.
    const dollarPatterns =
      syntax === 'wiki'
        ? []
        : alive
            .map(note => ({ id: note.id, pattern: dollarLinkPattern(note.title) }))
            .filter((entry): entry is { id: string; pattern: RegExp } => entry.pattern !== null)

    for (const note of this.notes) {
      const links = new Set<string>()
      const unresolved: string[] = []

      if (syntax === 'wiki' || syntax === 'both')
        for (const target of parseWikiLinks(note.content)) {
          const id = byTitle.get(norm(target))
          if (id && id !== note.id) links.add(id)
          else if (!id) unresolved.push(target)
        }

      // A body with no `$` at all cannot hold a dollar link — skip the scan.
      if (dollarPatterns.length && note.content.includes('$'))
        for (const { id, pattern } of dollarPatterns)
          if (id !== note.id && pattern.test(note.content)) links.add(id)

      note.links = Array.from(links)
      note.unresolved = Array.from(new Set(unresolved))
    }
  }

  private tags(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean).slice(0, 20) : []
  }

  private ensure(): void {
    if (!this.loaded) this.load()
  }

  private load(): void {
    this.loaded = true
    const data = readStoreJson<Partial<BrainSnapshot>>(this.file, {})
    const raw = Array.isArray(data.notes) ? data.notes : []
    // A note without a usable title would crash `reindex` (norm(undefined)) and
    // take the whole brain down with it — drop malformed entries loudly.
    this.notes = raw.filter(n => n && typeof n.id === 'string' && typeof n.title === 'string')
    const skipped = raw.length - this.notes.length
    if (skipped > 0) console.error(`dropped ${skipped} malformed note(s) without a title from ${this.file}`)
    // Notes whose trash stay has expired are dropped for good, silently.
    const cutoff = Date.now() - TRASH_TTL_MS
    const before = this.notes.length
    this.notes = this.notes.filter(n => !n.deletedAt || n.deletedAt > cutoff)
    if (this.notes.length !== before) this.save()
    this.reindex()
  }

  private save(): void {
    // PERF-004: a burst of edits (create + reindex + save per keystroke-batch)
    // collapses into one write; the app flushes pending writes on shutdown.
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 500)
  }

  /** Writes now, cancelling any pending debounce. */
  private flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      writeJsonAtomic(this.file, { notes: this.notes })
    } catch (err) {
      // Losing the write is bad, but taking the app down over it is worse — the
      // in-memory notes stay intact and the next edit retries the write.
      console.error('failed to persist second brain', err)
    }
  }

  /** Flushes any pending write; call from the app's shutdown path. */
  dispose(): void {
    this.flush()
  }
}
