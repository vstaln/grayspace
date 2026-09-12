import * as fs from 'fs'
import { promises as fsp } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import type { JournalEntry, JournalSink } from './core/index.ts'


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
      failed = true
    }
    this.writing = false
    if (failed) {
      this.scheduleRetry()
      return
    }
    if (this.bytes > this.maxBytes) this.rotate()



    if (this.durablePending) {
      this.durablePending = false
      if (this.buffer.length > 0) {
        const pending = this.buffer.join('\n') + '\n'
        this.buffer = []
        if (this.writeChunkSync(pending) && this.bytes > this.maxBytes) this.rotate()
      }
    }

    if (this.buffer.length > 0 && this.timer === null && this.retryTimer === null) {
      this.timer = setTimeout(() => void this.flushAsync(), this.flushMs)
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
      void this.flushAsync()
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






export function readJournalTail(file: string, limit = 2_000): { lastSeq: number; entries: JournalEntry[] } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { lastSeq: 0, entries: [] }
  }
  const entries: JournalEntry[] = []






  const lines = text.split('\n')
  let lastSeq = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as JournalEntry
      if (typeof entry.seq !== 'number' || typeof entry.type !== 'string') continue
      if (entry.seq > lastSeq) lastSeq = entry.seq
      if (entries.length < limit) entries.push(entry)
    } catch {


    }
  }
  entries.reverse()
  return { lastSeq, entries }
}
