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

  bytes: number
  savedAt: number
}
















export class TerminalSnapshots {
  private index: Record<string, TerminalSnapshot> = {}
  private loaded = false

  private shuttingDown = false

  private flushTimer: ReturnType<typeof setTimeout> | null = null






  private readonly generations = new Map<string, number>()

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








  save(input: { id: string; title: string; cwd: string; scrollback: string }): void {
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













  saveAsync(input: { id: string; title: string; cwd: string; scrollback: string }): void {
    this.ensure()



    if (this.shuttingDown) return
    const { text, entry } = this.prepare(input)
    const gen = (this.generations.get(input.id) ?? 0) + 1
    this.generations.set(input.id, gen)
    this.index[input.id] = entry
    void (async () => {
      try {
        await fsp.mkdir(this.dir, { recursive: true })
        if ((this.generations.get(input.id) ?? 0) !== gen) return



        await writeTextAtomicAsync(this.scrollbackFile(input.id), text)


        if ((this.generations.get(input.id) ?? 0) !== gen) {
          if (this.index[input.id] === entry) delete this.index[input.id]
          this.scheduleFlush()
          if (this.index[input.id] === undefined || this.index[input.id] === entry) {
            await fsp.rm(this.scrollbackFile(input.id), { force: true }).catch(() => {})
          }
        }
      } catch (err) {


        console.error(`failed to persist scrollback for ${input.id}`, err)
        if (this.index[input.id] === entry) {
          delete this.index[input.id]


          this.scheduleFlush()
        }
      }
    })()
    this.scheduleFlush()
  }

  private prepare(input: { id: string; title: string; cwd: string; scrollback: string }): {
    text: string
    entry: TerminalSnapshot
  } {








    const text = tail(preserveSgr(input.scrollback), MAX_SCROLLBACK_BYTES)
    return {
      text,
      entry: {
        id: input.id,
        title: input.title,
        cwd: input.cwd,
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
    if (!this.index[id]) return
    delete this.index[id]


    void fsp.rm(this.scrollbackFile(id), { force: true }).catch(() => {

    })
    this.scheduleFlush()
  }


  prune(liveIds: Iterable<string>): void {
    this.ensure()
    const keep = new Set(liveIds)
    for (const id of Object.keys(this.index)) if (!keep.has(id)) this.forget(id)
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
