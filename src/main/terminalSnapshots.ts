import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { readStoreJson, sweepTempFilesWithOptions, writeJsonAtomic, writeJsonAtomicAsync, writeTextAtomic, writeTextAtomicAsync } from './storage.ts'
import { preserveSgr } from './ansi.ts'
import { getUserDataDir } from './userData.ts'

export const TERMINAL_SCHEMA_VERSION = 1

/** How much cleaned scrollback one snapshot keeps on disk. */
export const MAX_SCROLLBACK_BYTES = 64 * 1024

/**
 * How much of the live ring buffer a snapshot reads before prepare() trims it.
 *
 * prepare() keeps only the last MAX_SCROLLBACK_BYTES after its SGR-preserving
 * pass, so reading the whole buffer is waste. The margin above that covers
 * text which is mostly escape sequences, where stripping shrinks the tail a
 * lot and a cut at exactly MAX_SCROLLBACK_BYTES would keep far less clean
 * text than that. Even bounded, the join and scan runs on the thread that
 * pumps every PTY, and on shutdown inside `before-quit`.
 */
export const SNAPSHOT_TAIL_BYTES = MAX_SCROLLBACK_BYTES * 4

/**
 * How long drainPendingSaves/flushNow wait for in-flight async scrollback
 * writes before giving up. Shutdown cannot block forever on a wedged disk.
 */
export const SNAPSHOT_DRAIN_TIMEOUT_MS = 5000

/** Quarantined (`*.corrupt-*`) files older than this are swept by prune(). */
export const SNAPSHOT_QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface TerminalSnapshot {
  id: string
  title: string
  cwd: string
  lastPrompt?: string

  bytes: number
  savedAt: number
}
















export class TerminalSnapshots {
  private index: Record<string, TerminalSnapshot> = Object.create(null)
  private loaded = false
  /** Set when the index on disk was written by a schema this build cannot read. */
  private foreignSchema = false

  private shuttingDown = false

  private flushTimer: ReturnType<typeof setTimeout> | null = null






  private readonly generations = new Map<string, number>()
  private readonly saveChains = new Map<string, Promise<void>>()
  private nextGeneration = 0
  private indexGeneration = 0
  private readonly indexWrites = new Set<Promise<void>>()

  private get dir(): string {
    return join(getUserDataDir(), 'terminals')
  }

  private get indexFile(): string {
    return join(this.dir, 'index.json')
  }

  private ensure(): void {
    if (this.loaded) return


    const raw = readStoreJson<{ schemaVersion?: number; terminals?: Record<string, TerminalSnapshot> }>(
      this.indexFile,
      {}
    )
    this.loaded = true
    // Unknown (newer) schema versions are ignored, not migrated: applying an
    // unknown layout as if it were v1 would resurrect or drop sessions
    // silently. Keep this store read-only until a compatible build opens it.
    if (
      raw !== null &&
      typeof raw === 'object' &&
      'schemaVersion' in raw &&
      raw.schemaVersion !== undefined &&
      raw.schemaVersion !== TERMINAL_SCHEMA_VERSION
    ) {
      console.warn(
        `ignoring terminal snapshot index with unknown schemaVersion ${String(raw.schemaVersion)} (expected ${TERMINAL_SCHEMA_VERSION})`
      )
      this.index = Object.create(null)
      this.foreignSchema = true
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const entries = raw.terminals
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object' || entry.id !== id ||
          typeof entry.title !== 'string' || typeof entry.cwd !== 'string' ||
          !Number.isFinite(entry.bytes) || entry.bytes < 0 || !Number.isFinite(entry.savedAt) ||
          (entry.lastPrompt !== undefined && typeof entry.lastPrompt !== 'string')) continue
      this.index[id] = entry
    }
  }


  beginShutdown(): void {
    this.shuttingDown = true
    // Shutdown must not leave the index behind the scrollback files: the
    // debounced async flush may still be pending, and the process can exit
    // before its timer fires. Write the index synchronously now; pending
    // scrollback chains are drained by drainPendingSaves()/flushNow().
    this.flush()
  }

  /**
   * Wait for in-flight saveAsync scrollback writes, bounded by a timeout.
   * Resolves when every chained write settles or the timeout elapses —
   * never rejects, so shutdown paths can always await it.
   */
  async drainPendingSaves(timeoutMs = SNAPSHOT_DRAIN_TIMEOUT_MS): Promise<void> {
    const pending = [...this.saveChains.values(), ...this.indexWrites]
    if (pending.length === 0) return
    const all = Promise.allSettled(pending.map((p) => p.catch(() => undefined)))
    if (timeoutMs <= 0) {
      await all
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        all,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  list(): TerminalSnapshot[] {
    this.ensure()
    return Object.values(this.index)
  }

  get(id: string): TerminalSnapshot | undefined {
    this.ensure()
    return this.index[id]
  }


  scrollback(id: string): string {
    this.ensure()
    if (!this.index[id]) return ''
    try {
      return fs.readFileSync(this.scrollbackFile(id), 'utf8')
    } catch {
      // Written by a build before scrollbackFile() hashed unsafe ids.
      const legacy = this.legacyScrollbackFile(id)
      if (legacy === null) return ''
      try {
        return fs.readFileSync(legacy, 'utf8')
      } catch {
        return ''
      }
    }
  }








  save(input: { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string }): void {
    this.ensure()
    if (this.foreignSchema) return
    const gen = ++this.nextGeneration
    this.generations.set(input.id, gen)
    const { text, entry } = this.prepare(input)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      writeTextAtomic(this.scrollbackFile(input.id), text)
    } catch (err) {
      console.error(`failed to persist scrollback for ${input.id}`, err)
      return
    }
    // Generation guard: forget() (or a newer save) invalidates this write —
    // without it a save racing a close resurrects a file the user deleted.
    if ((this.generations.get(input.id) ?? 0) !== gen) return
    this.index[input.id] = entry
    this.flush()
  }













  saveAsync(input: { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string }): void {
    this.ensure()



    if (this.shuttingDown || this.foreignSchema) return
    const { text, entry } = this.prepare(input)
    const gen = ++this.nextGeneration
    this.generations.set(input.id, gen)
    // The index is updated only after the scrollback file lands on disk
    // (generation-guarded). Updating it up-front left the index pointing at
    // bytes that never arrived when the write failed or was superseded.
    // Serialize writes per terminal id: without this, a superseded save can
    // finish after its replacement and leave stale scrollback on disk while
    // the index points at the newer entry.
    const previous = this.saveChains.get(input.id) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // forget() drops the generation: an in-flight save for a closed
        // terminal must not resurrect its file.
        if ((this.generations.get(input.id) ?? 0) !== gen) return
        try {
          await fsp.mkdir(this.dir, { recursive: true })
          if ((this.generations.get(input.id) ?? 0) !== gen) return
          await writeTextAtomicAsync(this.scrollbackFile(input.id), text,
            () => this.generations.get(input.id) === gen)
          if ((this.generations.get(input.id) ?? 0) !== gen) return
          this.index[input.id] = entry
          this.scheduleFlush()
        } catch (err) {
          console.error(`failed to persist scrollback for ${input.id}`, err)
        }
      })
    this.saveChains.set(input.id, current)
    void current
      .catch(() => undefined)
      .then(() => {
        if (this.saveChains.get(input.id) === current) this.saveChains.delete(input.id)
      })
    this.scheduleFlush()
  }

  private prepare(input: { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string }): {
    text: string
    entry: TerminalSnapshot
  } {








    const text = tail(preserveSgr(input.scrollback, true), MAX_SCROLLBACK_BYTES)
    return {
      text,
      entry: {
        id: input.id,
        title: input.title,
        cwd: input.cwd,
        ...(input.lastPrompt?.trim() ? { lastPrompt: input.lastPrompt.replace(/\s+/g, ' ').trim().slice(0, 12_000) } : {}),
        bytes: Buffer.byteLength(text),
        savedAt: Date.now()
      }
    }
  }

  forget(id: string): void {
    this.ensure()
    if (this.foreignSchema) return

    // Terminal ids are never reused. Dropping the generation marker both
    // invalidates in-flight async saves (their check sees a mismatch) and
    // keeps this map from growing by one entry per terminal for the lifetime
    // of the app.
    this.generations.delete(id)
    const indexed = this.index[id] !== undefined
    if (indexed) delete this.index[id]
    // The removal is not conditional on there having been an index entry. It
    // used to be, behind an early return, and a scrollback file whose entry
    // had already gone — the index write is debounced and asynchronous, so a
    // quit between the two loses it — could then never be deleted by anything.
    const removeIfUnshared = (file: string): void => {
      const target = snapshotPathKey(file)
      const owners = new Set([...Object.keys(this.index), ...this.generations.keys()])
      for (const owner of owners) {
        if (snapshotPathKey(this.scrollbackFile(owner)) === target) return
        const alias = this.legacyScrollbackFile(owner)
        if (alias !== null && snapshotPathKey(alias) === target) return
      }
      void fsp.rm(file, { force: true }).catch(() => {})
    }
    removeIfUnshared(this.scrollbackFile(id))
    const legacy = this.legacyScrollbackFile(id)
    if (legacy !== null) removeIfUnshared(legacy)
    if (indexed) this.scheduleFlush()
  }


  /**
   * Drop every snapshot that no longer belongs to a live terminal.
   *
   * The directory is swept, not just the index. Walking index keys alone
   * cannot see a file the index has forgotten, and those accumulate: measured
   * on one real profile, 3 index entries against 28 files on disk — 25
   * orphans, 623KB, with nothing in the app able to remove them.
   */
  prune(liveIds: Iterable<string>): void {
    this.ensure()
    const keep = new Set(liveIds)
    for (const id of new Set([...Object.keys(this.index), ...this.generations.keys()])) {
      if (!keep.has(id)) this.forget(id)
    }

    // Filenames rather than ids: scrollbackFile() sanitizes (and hashes on
    // collision), and comparing on its output avoids having to invert that
    // mapping. The pre-hash name counts as expected too, so an upgrade does
    // not delete a live terminal's existing snapshot out from under it.
    const expected = new Set<string>()
    for (const id of [...keep, ...Object.keys(this.index)]) {
      expected.add(snapshotPathKey(this.scrollbackFile(id)))
      const legacy = this.legacyScrollbackFile(id)
      if (legacy !== null) expected.add(snapshotPathKey(legacy))
    }
    // Quarantined store files (`index.json.corrupt-*`) and stale atomic-write
    // temps: the same sweep the user-data root gets, on the long clock, so
    // recent corruption stays diagnosable without piling up forever.
    sweepTempFilesWithOptions(this.dir, { corruptMaxAgeMs: SNAPSHOT_QUARANTINE_MAX_AGE_MS })
    // A newer build's index was unreadable, so `expected` is empty for reasons
    // that say nothing about what is on disk. Sweeping here would delete every
    // snapshot that build wrote before the user could go back to it.
    if (this.foreignSchema) return
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.log')) continue
        const file = join(this.dir, name)
        if (expected.has(snapshotPathKey(file))) continue
        try {
          fs.rmSync(file, { force: true })
        } catch {
          // A file another process still holds open is retried next shutdown.
        }
      }
    } catch {
      // No directory yet, or it cannot be read; nothing to sweep.
    }
  }

  private scrollbackFile(id: string): string {
    // Plain sanitizing collides: "a:b" and "a_b" both become "a_b.log" and
    // the second terminal silently overwrites the first's scrollback. Ids
    // that are already filesystem-safe keep their legacy name (so existing
    // snapshots keep working); mixed case on Windows and anything else get a hash of the full
    // id, which makes collisions cryptographically unlikely while staying
    // human-readable.
    if (this.canUsePlainFilename(id)) return join(this.dir, `${id}.log`)
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '_')
    const hash = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12)
    return join(this.dir, `${safe}-${hash}.log`)
  }

  /**
   * What scrollbackFile() returned before the hash was added.
   *
   * Only ids that need sanitizing have one, and only those written by an
   * older build. Reads fall back to it and deletes cover it, so upgrading
   * neither loses a snapshot nor strands its file on disk forever.
   */
  private legacyScrollbackFile(id: string): string | null {
    if (this.canUsePlainFilename(id)) return null
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.log`)
  }

  private canUsePlainFilename(id: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(id) && (process.platform !== 'win32' || id === id.toLowerCase())
  }


  private flush(): void {
    this.ensure()
    if (this.foreignSchema) return
    this.indexGeneration += 1
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      writeJsonAtomic(this.indexFile, { schemaVersion: TERMINAL_SCHEMA_VERSION, terminals: this.index })
    } catch (err) {
      console.error('failed to persist the terminal index', err)
    }
  }


  private scheduleFlush(): void {
    this.indexGeneration += 1
    if (this.shuttingDown) return
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const snapshot = { schemaVersion: TERMINAL_SCHEMA_VERSION, terminals: { ...this.index } }
      const generation = this.indexGeneration
      const pending = writeJsonAtomicAsync(this.indexFile, snapshot,
        () => this.indexGeneration === generation).catch((err) => {
        console.error('failed to persist the terminal index', err)
      })
      this.indexWrites.add(pending)
      void pending.then(() => this.indexWrites.delete(pending))
    }, 400)
    this.flushTimer.unref?.()
  }


  flushNow(): Promise<void> {
    // Synchronous index write first: callers that do not await (including
    // the shutdown path) still leave a consistent index on disk. The
    // returned promise drains in-flight scrollback chains with a timeout —
    // flushing the index alone used to declare success while up to a full
    // debounce interval of scrollback was still in flight.
    this.flush()
    return this.drainPendingSaves().then(() => this.flush())
  }
}








function tail(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= limit) return stripTrailingPartialEscape(text)


  const cut = buf.subarray(buf.length - limit).toString('utf8')
  const aligned = newlineAwareCut(cut)
  return stripTrailingPartialEscape(aligned)
}

function snapshotPathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function newlineAwareCut(cut: string): string {
  const newline = cut.indexOf('\n')
  return newline >= 0 ? cut.slice(newline + 1) : cut.replace(/^�+/, '')
}

/**
 * Back off a trailing partial ANSI escape.
 *
 * tail() cuts at an arbitrary byte offset, which can land mid-sequence
 * ("...output\x1b[" or "...\x1b[31"). Restoring that file would leave xterm
 * waiting inside the sequence and swallow or tint everything after it. A
 * complete sequence ending exactly at the cut is kept; only a prefix without
 * its final byte is removed.
 */
function stripTrailingPartialEscape(text: string): string {
  // A terminal string escape can contain a final ESC byte when the cut lands
  // between ESC and its ST terminator. Removing only that byte leaves the
  // OSC/DCS introducer open and makes restored output disappear into it.
  const stringStart = Math.max(
    text.lastIndexOf('\x1b]'),
    text.lastIndexOf('\x1bP'),
    text.lastIndexOf('\x1bX'),
    text.lastIndexOf('\x1b^'),
    text.lastIndexOf('\x1b_')
  )
  if (stringStart >= 0) {
    const sequence = text.slice(stringStart)
    if (!sequence.includes('\x07') && !sequence.includes('\x1b\\')) {
      return text.slice(0, stringStart)
    }
  }
  if (text.endsWith('\x1b')) return text.slice(0, -1)
  // CSI: ESC [ params(0x30-0x3F) intermediates(0x20-0x2F) final(0x40-0x7E).
  // Anything matching here has no final byte, so it is a prefix. The
  // parameter class must include the private markers `<=>?`, or a cut inside
  // "\x1b[>4c" would leave "\x1b[>4" behind.
  const csi = text.match(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*$/)
  if (csi) return text.slice(0, text.length - csi[0].length)
  // String sequences: OSC (ESC ]), DCS (ESC P), SOS/PM/APC (ESC X/^/_). Each
  // runs to BEL or ST (ESC \), so a run containing neither is unterminated.
  const str = text.match(/\x1b[\]PX^_][^\x07\x1b]*$/)
  if (str) return text.slice(0, text.length - str[0].length)
  return text
}
