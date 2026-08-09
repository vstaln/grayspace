import * as fs from 'fs'
import { dirname } from 'path'
import type { JournalEntry, JournalSink } from './core/index.ts'

/** Bumped whenever the on-disk journal line format changes. */
export const JOURNAL_SCHEMA_VERSION = 1

/** Rotate once the log passes this, so startup never parses a huge file. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

interface FileJournalOptions {
  file: string
  maxBytes?: number
  /** Entries are buffered for this long before hitting the disk. */
  flushMs?: number
}

/**
 * NDJSON append sink for the command journal.
 *
 * One line per entry, appended and never rewritten: an append is the only file
 * operation that a crash cannot corrupt retroactively, which matters because
 * this log is what recovery reads to decide whether a half-finished command
 * needs replaying.
 *
 * Writes are batched on a short timer. A burst of canvas commands (dragging a
 * widget emits one per frame) would otherwise mean one syscall per frame.
 */
export class FileJournalSink implements JournalSink {
  private readonly file: string
  private readonly maxBytes: number
  private readonly flushMs: number
  private buffer: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private bytes = 0

  constructor(options: FileJournalOptions) {
    this.file = options.file
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.flushMs = options.flushMs ?? 250
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true })
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    } catch (err) {
      console.error('cannot prepare journal file', err)
    }
  }

  append(entry: JournalEntry): void {
    this.buffer.push(JSON.stringify(entry))
    if (this.timer !== null) return
    this.timer = setTimeout(() => this.flush(), this.flushMs)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return
    const chunk = this.buffer.join('\n') + '\n'
    this.buffer = []
    try {
      fs.appendFileSync(this.file, chunk, 'utf8')
      this.bytes += Buffer.byteLength(chunk)
      if (this.bytes > this.maxBytes) this.rotate()
    } catch (err) {
      console.error('failed to append to the command journal', err)
    }
  }

  /**
   * Compaction, the cheap version: the tail is kept (it is the recovery and
   * undo window) and everything older is dropped. Nothing reconstructs state
   * from the journal alone — the stores hold their own snapshots — so old
   * entries are history, not data, and history has a budget.
   */
  private rotate(): void {
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      const lines = text.split('\n').filter(Boolean)
      const keep = lines.slice(-2_000)
      fs.writeFileSync(`${this.file}.tmp`, keep.join('\n') + '\n', 'utf8')
      fs.renameSync(`${this.file}.tmp`, this.file)
      this.bytes = fs.statSync(this.file).size
    } catch (err) {
      console.error('failed to compact the command journal', err)
    }
  }
}

/**
 * Reads the journal back on startup: the highest sequence seen (so new entries
 * continue the numbering instead of colliding with the old ones) and the tail,
 * which recovery scans for commands that never committed.
 */
export function readJournalTail(file: string, limit = 2_000): { lastSeq: number; entries: JournalEntry[] } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { lastSeq: 0, entries: [] }
  }
  const entries: JournalEntry[] = []
  for (const line of text.split('\n').slice(-limit)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as JournalEntry
      if (typeof entry.seq === 'number' && typeof entry.type === 'string') entries.push(entry)
    } catch {
      // A torn final line is expected after a hard kill — skip it rather than
      // treating the whole journal as corrupt.
    }
  }
  const lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0)
  return { lastSeq, entries }
}
