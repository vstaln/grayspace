import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import type { JournalEntry, JournalSink } from './core/index.ts'

/** Bumped whenever the on-disk journal line format changes. */
export const JOURNAL_SCHEMA_VERSION = 1

/** Rotate once the log passes this, so startup never parses a huge file. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Hard ceiling on the in-RAM backlog. Under sustained disk failure the retry
 * loop is unbounded by design; without this cap every retried append would
 * keep feeding the buffer until the main process OOMs.
 */
const MAX_BUFFER_LINES = 5_000

interface FileJournalOptions {
  file: string
  maxBytes?: number
  /** Entries are buffered for this long before hitting the disk. */
  flushMs?: number
  /** How long to wait before retrying after a failed flush, at most. */
  retryMaxMs?: number
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
 *
 * The timer-driven write is asynchronous. It used to be `openSync` +
 * `writeSync` + **`fsyncSync`** + `closeSync`, and this sink runs in the
 * Electron main process — the single thread that also serves every IPC call,
 * every pty chunk and the window itself. An fsync costs milliseconds on
 * Windows and far more when the disk is busy (which, in an app whose whole job
 * is running build tools and agents, it usually is), so the app visibly hitched
 * several times a second while anything was writing to the journal.
 *
 * `flush()` stays synchronous and still fsyncs: it is the shutdown path, where
 * blocking is exactly what is wanted — Electron must not tear the process down
 * mid-write. The periodic path trades an fsync for not stalling the UI; the
 * bytes still reach the file in order, and the worst case a crash can cost is
 * the entries buffered since the last flush, which were never on disk anyway.
 */
export class FileJournalSink implements JournalSink {
  private readonly file: string
  private readonly maxBytes: number
  private readonly flushMs: number
  private readonly retryMaxMs: number
  private buffer: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryMs: number
  private bytes = 0
  /** True while an async append is in flight; keeps batches from interleaving. */
  private writing = false
  /**
   * Set when the durable flush() found an async write mid-flight. The newer
   * chunk must NOT hit disk before the older in-flight one (recovery replays
   * lines positionally), so the async completion path performs the durable
   * write once ordering is restored.
   */
  private durablePending = false

  constructor(options: FileJournalOptions) {
    this.file = options.file
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.flushMs = options.flushMs ?? 250
    this.retryMaxMs = options.retryMaxMs ?? 10_000
    this.retryMs = this.flushMs
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true })
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
    } catch (err) {
      console.error('cannot prepare journal file', err)
    }
  }

  append(entry: JournalEntry): void {
    this.buffer.push(JSON.stringify(entry))
    if (this.timer !== null || this.retryTimer !== null) return
    this.timer = setTimeout(() => void this.flushAsync(), this.flushMs)
    this.timer.unref?.()
  }

  /**
   * The periodic write: same batching and same retry-on-failure as `flush()`,
   * off the event loop's critical path and without the fsync.
   */
  private async flushAsync(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    // One write at a time, or two overlapping appends could interleave their
    // batches and produce lines out of sequence.
    if (this.writing) return
    if (this.buffer.length === 0) return
    const chunk = this.buffer.join('\n') + '\n'
    this.buffer = []
    this.writing = true
    let failed = false
    try {
      await fsp.appendFile(this.file, chunk, 'utf8')
      this.bytes += Buffer.byteLength(chunk)
      this.retryMs = this.flushMs
    } catch (err) {
      // Keep entries queued when the profile is temporarily unavailable, and
      // put them back *in front* of anything appended while the write was in
      // flight so the file stays in sequence order.
      this.requeue(chunk)
      console.error('failed to append to the command journal', err)
      failed = true
    }
    this.writing = false
    if (failed) {
      this.scheduleRetry()
      return
    }
    if (this.bytes > this.maxBytes) this.rotate()
    // A shutdown flush() arrived while the write above was in flight: it
    // deferred to keep the file in sequence order, so finish it here —
    // synchronously and durably, now that ordering is guaranteed again.
    if (this.durablePending) {
      this.durablePending = false
      if (this.buffer.length > 0) {
        const pending = this.buffer.join('\n') + '\n'
        this.buffer = []
        if (this.writeChunkSync(pending) && this.bytes > this.maxBytes) this.rotate()
      }
    }
    // Entries that arrived while the write was in flight need their own timer.
    if (this.buffer.length > 0 && this.timer === null && this.retryTimer === null) {
      this.timer = setTimeout(() => void this.flushAsync(), this.flushMs)
      this.timer.unref?.()
    }
  }

  /**
   * Durable, blocking flush. Shutdown only — see the class comment.
   */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    // An async append is mid-flight: writing the newer buffered chunk now
    // could land it on disk *before* the older batch, and recovery replays
    // lines positionally. Defer to the async completion path, which performs
    // this durable write the moment ordering is restored.
    if (this.writing) {
      this.durablePending = true
      return
    }
    if (this.buffer.length === 0) return
    const chunk = this.buffer.join('\n') + '\n'
    this.buffer = []
    if (this.writeChunkSync(chunk) && this.bytes > this.maxBytes) this.rotate()
  }

  /**
   * One synchronous append + fsync. Returns false after requeueing on
   * failure; retries once immediately, because at shutdown the unref'd retry
   * timer would never fire and the entries would be lost.
   */
  private writeChunkSync(chunk: string): boolean {
    try {
      // One fd so a crash cannot leave the last batch only in the page cache:
      // recovery treats a missing commit line as an unfinished command.
      const handle = fs.openSync(this.file, 'a')
      try {
        fs.writeSync(handle, chunk, undefined, 'utf8')
        fs.fsyncSync(handle)
      } finally {
        fs.closeSync(handle)
      }
      this.bytes += Buffer.byteLength(chunk)
      this.retryMs = this.flushMs
      return true
    } catch (err) {
      try {
        const handle = fs.openSync(this.file, 'a')
        try {
          fs.writeSync(handle, chunk, undefined, 'utf8')
          fs.fsyncSync(handle)
        } finally {
          fs.closeSync(handle)
        }
        this.bytes += Buffer.byteLength(chunk)
        this.retryMs = this.flushMs
        return true
      } catch (retryErr) {
        // Keep entries queued when the profile is temporarily unavailable. A
        // transient sharing/permission error must not silently erase the
        // journal records that recovery depends on.
        this.requeue(chunk)
        console.error('failed to append to the command journal', retryErr)
        this.scheduleRetry()
        return false
      }
    }
  }

  /** Puts a failed batch back at the front of the queue, bounded. */
  private requeue(chunk: string): void {
    const lines = chunk.trimEnd().split('\n').filter(Boolean)
    this.buffer = lines.concat(this.buffer)
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_LINES)
    }
  }

  /** Back off and try again — a failed flush used to sit in RAM until the next command. */
  private scheduleRetry(): void {
    if (this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flushAsync()
    }, this.retryMs)
    this.retryTimer.unref?.()
    this.retryMs = Math.min(this.retryMs * 2, this.retryMaxMs)
  }

  /**
   * Compaction, the cheap version: the tail is kept (it is the recovery and
   * undo window) and everything older is dropped. Nothing reconstructs state
   * from the journal alone — the stores hold their own snapshots — so old
   * entries are history, not data, and history has a budget.
   */
  private rotate(): void {
    // An async append may still be running against the current file: its fd
    // would keep writing into the renamed-away inode and those lines would be
    // lost. Skip now — the next successful flush retries compaction.
    if (this.writing) return
    try {
      const text = fs.readFileSync(this.file, 'utf8')
      const lines = text.split('\n').filter(Boolean)
      const keep = lines.slice(-2_000)
      const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
      try {
        const handle = fs.openSync(temp, 'w')
        try {
          fs.writeFileSync(handle, keep.join('\n') + '\n', 'utf8')
          fs.fsyncSync(handle)
        } finally {
          fs.closeSync(handle)
        }
        fs.renameSync(temp, this.file)
      } finally {
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp)
        } catch {
          /* disposable compaction artifact */
        }
      }
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
  // Walk from the end so a trailing newline (every successful flush writes one)
  // or a torn last line cannot make lastSeq look like 0. Callers that pass
  // `limit: 1` still need the highest real sequence, not the empty final slot.
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i -= 1) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as JournalEntry
      if (typeof entry.seq === 'number' && typeof entry.type === 'string') entries.push(entry)
    } catch {
      // A torn final line is expected after a hard kill — skip it rather than
      // treating the whole journal as corrupt.
    }
  }
  entries.reverse()
  const lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0)
  return { lastSeq, entries }
}
