import { app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'

export const TERMINAL_SCHEMA_VERSION = 1

/** Scrollback kept per terminal. Build logs reach megabytes; this is the budget. */
const MAX_SCROLLBACK_BYTES = 64 * 1024

export interface TerminalSnapshot {
  id: string
  title: string
  cwd: string
  /** Byte length of the saved scrollback; the text lives in its own file. */
  bytes: number
  savedAt: number
}

/**
 * Terminals across a restart, the honest way.
 *
 * A PTY is an OS child of this process and dies with it — there is no saving
 * that, short of a detached broker process, which on Windows means writing one
 * over ConPTY and named pipes. So what is restored is the *context*: the
 * working directory, the title, and the text that was on screen. Reopening a
 * terminal renders the saved scrollback as static text and starts a fresh
 * shell in the same directory, and a `npm run dev` that was running is simply
 * gone — visibly, rather than pretending otherwise.
 *
 * Scrollback lives in one file per terminal, never in the layout JSON: opening
 * a workspace must not block on parsing megabytes of build output before it
 * can draw a single widget.
 */
export class TerminalSnapshots {
  private index: Record<string, TerminalSnapshot> = {}
  private loaded = false

  private get dir(): string {
    return join(app.getPath('userData'), 'terminals')
  }

  private get indexFile(): string {
    return join(this.dir, 'index.json')
  }

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    const raw = readStoreJson<{ schemaVersion?: number; terminals?: Record<string, TerminalSnapshot> }>(
      this.indexFile,
      {}
    )
    this.index = raw.terminals && typeof raw.terminals === 'object' ? raw.terminals : {}
  }

  list(): TerminalSnapshot[] {
    this.ensure()
    return Object.values(this.index)
  }

  get(id: string): TerminalSnapshot | undefined {
    this.ensure()
    return this.index[id]
  }

  /** The saved screen for a terminal, or an empty string when there is none. */
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
    const text = tail(input.scrollback, MAX_SCROLLBACK_BYTES)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.scrollbackFile(input.id), text, 'utf8')
    } catch (err) {
      console.error(`failed to persist scrollback for ${input.id}`, err)
      return
    }
    this.index[input.id] = {
      id: input.id,
      title: input.title,
      cwd: input.cwd,
      bytes: Buffer.byteLength(text),
      savedAt: Date.now()
    }
    this.flush()
  }

  forget(id: string): void {
    this.ensure()
    if (!this.index[id]) return
    delete this.index[id]
    try {
      fs.rmSync(this.scrollbackFile(id), { force: true })
    } catch {
      /* a leftover file is harmless */
    }
    this.flush()
  }

  /** Drops snapshots for terminals no widget refers to any more. */
  prune(liveIds: Iterable<string>): void {
    this.ensure()
    const keep = new Set(liveIds)
    for (const id of Object.keys(this.index)) if (!keep.has(id)) this.forget(id)
  }

  private scrollbackFile(id: string): string {
    // Ids are app-generated (`term-…`, `agent-…`, `terminal-…`), but this is a
    // filename, so anything outside the safe set is replaced rather than
    // trusted to stay inside the directory.
    return join(this.dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.log`)
  }

  private flush(): void {
    try {
      writeJsonAtomic(this.indexFile, { schemaVersion: TERMINAL_SCHEMA_VERSION, terminals: this.index })
    } catch (err) {
      console.error('failed to persist the terminal index', err)
    }
  }
}

/** Last `limit` bytes, cut at a line boundary so the top is not half a line. */
function tail(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text
  const cut = text.slice(-limit)
  const newline = cut.indexOf('\n')
  return newline >= 0 ? cut.slice(newline + 1) : cut
}
