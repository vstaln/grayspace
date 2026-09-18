import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic, writeJsonAtomicAsync, writeTextAtomic, writeTextAtomicAsync } from './storage.ts'
import { preserveSgr } from './ansi.ts'
import { getUserDataDir } from './userData.ts'

export const TERMINAL_SCHEMA_VERSION = 1


const MAX_SCROLLBACK_BYTES = 64 * 1024

export interface TerminalSnapshot {
  id: string
  title: string
  cwd: string
  lastPrompt?: string

  bytes: number
  savedAt: number
}
















export class TerminalSnapshots {
  private index: Record<string, TerminalSnapshot> = {}
  private loaded = false

  private shuttingDown = false

  private flushTimer: ReturnType<typeof setTimeout> | null = null






  private readonly generations = new Map<string, number>()
  private readonly saveChains = new Map<string, Promise<void>>()

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
    this.index = raw.terminals && typeof raw.terminals === 'object' ? raw.terminals : {}
  }


  beginShutdown(): void {
    this.shuttingDown = true
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
      return ''
    }
  }








  save(input: { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string }): void {
    this.ensure()
    this.generations.set(input.id, (this.generations.get(input.id) ?? 0) + 1)
    const { text, entry } = this.prepare(input)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      writeTextAtomic(this.scrollbackFile(input.id), text)
    } catch (err) {
      console.error(`failed to persist scrollback for ${input.id}`, err)
      return
    }
    this.index[input.id] = entry
    this.flush()
  }













  saveAsync(input: { id: string; title: string; cwd: string; scrollback: string; lastPrompt?: string }): void {
    this.ensure()



    if (this.shuttingDown) return
    const { text, entry } = this.prepare(input)
    const gen = (this.generations.get(input.id) ?? 0) + 1
    this.generations.set(input.id, gen)
    this.index[input.id] = entry
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
          await writeTextAtomicAsync(this.scrollbackFile(input.id), text)
          if ((this.generations.get(input.id) ?? 0) !== gen) {
            // Superseded between mkdir and write completion: the replacement
            // is already chained behind us and will write the newer text.
            if (this.index[input.id] === entry) delete this.index[input.id]
            this.scheduleFlush()
          }
        } catch (err) {
          console.error(`failed to persist scrollback for ${input.id}`, err)
          if (this.index[input.id] === entry) {
            delete this.index[input.id]
            this.scheduleFlush()
          }
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
    void fsp.rm(this.scrollbackFile(id), { force: true }).catch(() => {

    })
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
    for (const id of Object.keys(this.index)) if (!keep.has(id)) this.forget(id)

    // Filenames rather than ids: scrollbackFile() sanitizes, and comparing on
    // its output avoids having to invert that mapping.
    const expected = new Set<string>()
    for (const id of keep) expected.add(this.scrollbackFile(id))
    for (const id of Object.keys(this.index)) expected.add(this.scrollbackFile(id))
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.log')) continue
        const file = join(this.dir, name)
        if (expected.has(file)) continue
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



    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.log`)
  }


  private flush(): void {
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
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const snapshot = { schemaVersion: TERMINAL_SCHEMA_VERSION, terminals: { ...this.index } }
      void writeJsonAtomicAsync(this.indexFile, snapshot).catch((err) => {
        console.error('failed to persist the terminal index', err)
      })
    }, 400)
    this.flushTimer.unref?.()
  }


  flushNow(): void {
    if (this.flushTimer === null) return
    this.flush()
  }
}








function tail(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= limit) return text


  const cut = buf.subarray(buf.length - limit).toString('utf8')
  const newline = cut.indexOf('\n')
  return newline >= 0 ? cut.slice(newline + 1) : cut.replace(/^�+/, '')
}
