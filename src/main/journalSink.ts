import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import type { JournalEntry, JournalSink } from './core/index.ts'
import { notifyPersistError } from './persistNotifier.ts'


export const JOURNAL_SCHEMA_VERSION = 1


const DEFAULT_MAX_BYTES = 4 * 1024 * 1024






const MAX_BUFFER_LINES = 5_000

interface FileJournalOptions {
  file: string
  maxBytes?: number

  flushMs?: number

  retryMaxMs?: number
}


























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

  private writing = false
  private activeFlush: Promise<void> | null = null






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
      notifyPersistError('journal', err)
    }
  }

  append(entry: JournalEntry): void {
    this.buffer.push(JSON.stringify(entry))
    if (this.timer !== null || this.retryTimer !== null) return
    this.timer = setTimeout(() => this.startFlush(), this.flushMs)
    this.timer.unref?.()
  }





  private startFlush(): void {
    if (this.activeFlush) {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      return
    }
    const pending = this.flushAsync()
    this.activeFlush = pending
    void pending.then(() => {
      if (this.activeFlush === pending) this.activeFlush = null
    })
  }

  /** Wait for an in-flight append/rotation before flushing its buffered tail. */
  async flushPending(): Promise<void> {
    this.flush()
    await this.activeFlush
    this.flush()
  }

  private async flushAsync(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }


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



      this.requeue(chunk)
      console.error('failed to append to the command journal', err)
      notifyPersistError('journal', err)
      failed = true
    }
    if (failed) {
      this.writing = false
      this.scheduleRetry()
      return
    }
    if (this.bytes > this.maxBytes) await this.rotateAsync()
    this.writing = false



    if (this.durablePending) {
      this.durablePending = false
      if (this.buffer.length > 0) {
        const pending = this.buffer.join('\n') + '\n'
        this.buffer = []
        if (this.writeChunkSync(pending) && this.bytes > this.maxBytes) this.rotate()
      }
    }

    if (this.buffer.length > 0 && this.timer === null && this.retryTimer === null) {
      this.timer = setTimeout(() => this.startFlush(), this.flushMs)
      this.timer.unref?.()
    }
  }




  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }




    if (this.writing) {
      this.durablePending = true
      return
    }
    if (this.buffer.length === 0) return
    const chunk = this.buffer.join('\n') + '\n'
    this.buffer = []
    if (this.writeChunkSync(chunk) && this.bytes > this.maxBytes) this.rotate()
  }






  private writeChunkSync(chunk: string): boolean {
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



        this.requeue(chunk)
        console.error('failed to append to the command journal', retryErr)
        notifyPersistError('journal', retryErr)
        this.scheduleRetry()
        return false
      }
    }
  }


  private requeue(chunk: string): void {
    const lines = chunk.trimEnd().split('\n').filter(Boolean)
    this.buffer = lines.concat(this.buffer)
    if (this.buffer.length > MAX_BUFFER_LINES) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_LINES)
    }
  }


  private scheduleRetry(): void {
    if (this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.startFlush()
    }, this.retryMs)
    this.retryTimer.unref?.()
    this.retryMs = Math.min(this.retryMs * 2, this.retryMaxMs)
  }







  /**
   * Byte count at which a rotation may next be attempted.
   *
   * Rotation is triggered by `bytes > maxBytes`, and a failed attempt leaves
   * `bytes` exactly where it was — so a rotation that cannot succeed (the file
   * held open by a virus scanner, a full disk defeating the temp write) was
   * retried on *every* subsequent append, each retry reading the whole
   * multi-megabyte journal synchronously on the main thread. One unlucky
   * moment turned into a permanent stall. After a failure the journal must
   * grow by another full budget before trying again.
   */
  private rotateFloorBytes = 0

  /**
   * Compaction on the normal path, off the main thread.
   *
   * `rotate()` below reads the whole multi-megabyte journal with readFileSync,
   * on the thread that pumps every PTY. `rotateFloorBytes` made that rare;
   * it did not make it non-blocking, so every rotation still stopped every
   * terminal at once. The scheduled flush now awaits instead.
   *
   * `writing` is held for the whole rotation, not just the write. An append
   * that landed between the read and the rename would be dropped: appendFile
   * opens by path, so it would write into the file the rename is about to
   * replace. The synchronous version cannot interleave, which is why it does
   * not need this.
   */
  private async rotateAsync(): Promise<void> {
    if (this.bytes <= this.rotateFloorBytes) return
    const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const text = await fsp.readFile(this.file, 'utf8')
      const keep = text.split('\n').filter(Boolean).slice(-2_000)
      const handle = await fsp.open(temp, 'w')
      try {
        await handle.writeFile(keep.join('\n') + '\n', 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fsp.rename(temp, this.file)
      this.bytes = (await fsp.stat(this.file)).size
      this.rotateFloorBytes = 0
    } catch (err) {
      this.rotateFloorBytes = this.bytes + this.maxBytes
      console.error('failed to compact the command journal', err)
    } finally {
      // The rename consumes the temp on success; on failure it may remain.
      await fsp.unlink(temp).catch(() => {})
    }
  }

  /** Compaction on the shutdown paths, where blocking is the point. */
  private rotate(): void {
    if (this.writing) return
    if (this.bytes <= this.rotateFloorBytes) return
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

        }
      }
      this.bytes = fs.statSync(this.file).size
      this.rotateFloorBytes = 0
    } catch (err) {
      this.rotateFloorBytes = this.bytes + this.maxBytes
      console.error('failed to compact the command journal', err)
    }
  }
}






const JOURNAL_TAIL_MIN_BYTES = 64 * 1024
const JOURNAL_TAIL_MAX_INITIAL_BYTES = 4 * 1024 * 1024
const JOURNAL_ESTIMATED_ENTRY_BYTES = 512

export function readJournalTail(file: string, limit = 2_000): { lastSeq: number; entries: JournalEntry[] } {
  let handle: number
  let size: number
  try {
    handle = fs.openSync(file, 'r')
    size = fs.fstatSync(handle).size
  } catch {
    return { lastSeq: 0, entries: [] }
  }

  const maxEntries = Number.isFinite(limit)
    ? Math.max(0, Math.trunc(limit))
    : limit === Infinity ? Infinity : 0
  try {
    if (size === 0) return { lastSeq: 0, entries: [] }
    const estimatedTailBytes = Math.min(
      JOURNAL_TAIL_MAX_INITIAL_BYTES,
      Math.max(JOURNAL_TAIL_MIN_BYTES, maxEntries * JOURNAL_ESTIMATED_ENTRY_BYTES)
    )
    let windowBytes = Math.min(size, estimatedTailBytes)
    for (;;) {
      const start = size - windowBytes
      const buffer = Buffer.allocUnsafe(windowBytes)
      let bytesRead = 0
      while (bytesRead < windowBytes) {
        const count = fs.readSync(handle, buffer, bytesRead, windowBytes - bytesRead, start + bytesRead)
        if (count === 0) break
        bytesRead += count
      }

      let text = buffer.subarray(0, bytesRead).toString('utf8')
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline < 0 ? '' : text.slice(firstNewline + 1)
      }

      const entries: JournalEntry[] = []
      let lastSeq = 0
      let validEntries = 0
      const needed = Math.max(1, maxEntries)
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as JournalEntry
          if (typeof entry.seq !== 'number' || typeof entry.type !== 'string') continue
          if (entry.seq > lastSeq) lastSeq = entry.seq
          if (entries.length < maxEntries) entries.push(entry)
          validEntries += 1
          if (validEntries >= needed) break
        } catch {

        }
      }

      if (validEntries >= needed || start === 0) {
        entries.reverse()
        return { lastSeq, entries }
      }
      windowBytes = Math.min(size, windowBytes * 2)
    }
  } finally {
    fs.closeSync(handle)
  }
}
