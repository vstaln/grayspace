import { EventEmitter } from 'events'

export interface BatcherOptions {
  frameIntervalMs?: number
  maxBatchBytes?: number
  maxPendingBytes?: number
}

/** Cancel partial control state after output loss, including stale mouse reporting. */
const RESYNC_PREFIX =
  '\x18\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' +
  '\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l' +
  '\x1b[?2026l\x1b[?25h\x1b[0m'






export class TerminalStreamBatcher extends EventEmitter {
  private readonly pending = new Map<string, string[]>()
  private readonly pendingBytes = new Map<string, number>()
  private readonly frameIntervalMs: number
  private readonly maxBatchBytes: number
  private readonly maxPendingBytes: number
  /**
   * Same resync contract as TerminalOutputGate: when pressure forces a drop
   * of the oldest chunks, the next emitted batch carries an invisible SGR
   * reset so a sequence cut in half cannot corrupt everything after it or
   * leave xterm stuck inside a synchronized-output frame.
   */
  private readonly resyncPending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private immediate: NodeJS.Immediate | null = null

  constructor(options: BatcherOptions = {}) {
    super()
    this.frameIntervalMs = options.frameIntervalMs ?? 0
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024
    this.maxPendingBytes = options.maxPendingBytes ?? 256 * 1024
  }

  private static chunkBytes(chunk: string): number {
    return Buffer.byteLength(chunk, 'utf8')
  }

  private static sliceTailBytes(chunk: string, maxBytes: number): string {
    if (TerminalStreamBatcher.chunkBytes(chunk) <= maxBytes) return chunk
    let bytes = 0
    let cut = chunk.length
    while (cut > 0) {
      const low = chunk.charCodeAt(cut - 1)
      let charLen = 1
      let charBytes: number
      if (low >= 0xdc00 && low <= 0xdfff && cut >= 2) {
        const high = chunk.charCodeAt(cut - 2)
        if (high >= 0xd800 && high <= 0xdbff) {
          charLen = 2
          charBytes = 4
        } else {
          charBytes = 3
        }
      } else if (low < 0x80) {
        charBytes = 1
      } else if (low < 0x800) {
        charBytes = 2
      } else {
        charBytes = 3
      }
      if (bytes + charBytes > maxBytes) break
      bytes += charBytes
      cut -= charLen
    }
    return chunk.slice(cut)
  }

  push(terminalId: string, chunk: string): void {
    if (!chunk) return

    let list = this.pending.get(terminalId)
    if (!list) {
      list = []
      this.pending.set(terminalId, list)
      this.pendingBytes.set(terminalId, 0)
    }

    const incomingBytes = TerminalStreamBatcher.chunkBytes(chunk)
    let currentBytes = (this.pendingBytes.get(terminalId) || 0) + incomingBytes
    while (list.length > 0 && currentBytes > this.maxPendingBytes) {
      const dropped = list.shift()!
      currentBytes -= TerminalStreamBatcher.chunkBytes(dropped)
      this.resyncPending.add(terminalId)
    }
    const tail = TerminalStreamBatcher.sliceTailBytes(chunk, this.maxPendingBytes)
    if (tail !== chunk) this.resyncPending.add(terminalId)
    currentBytes -= incomingBytes - TerminalStreamBatcher.chunkBytes(tail)
    list.push(tail)
    this.pendingBytes.set(terminalId, currentBytes)

    if (currentBytes >= this.maxBatchBytes) {
      this.flushTerminal(terminalId)
    } else {
      this.ensureTimer()
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.immediate !== null) return
    if (this.frameIntervalMs <= 0) {
      // Coalesce the current I/O turn without delaying keyboard echo by a frame.
      this.immediate = setImmediate(() => {
        this.immediate = null
        this.flushAll()
      })
      this.immediate.unref?.()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushAll()
    }, this.frameIntervalMs)
    this.timer.unref?.()
  }




  flush(terminalId: string): void {
    this.flushTerminal(terminalId)
  }

  private flushTerminal(terminalId: string): void {
    const list = this.pending.get(terminalId)
    if (!list || list.length === 0) return

    const combined = list.length === 1 ? list[0] : list.join('')
    this.pending.delete(terminalId)
    this.pendingBytes.delete(terminalId)

    const batch = this.resyncPending.delete(terminalId) ? `${RESYNC_PREFIX}${combined}` : combined
    this.emit('batch', terminalId, batch)
  }

  flushAll(): void {
    if (this.immediate !== null) {
      clearImmediate(this.immediate)
      this.immediate = null
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.pending.size === 0) return

    const ids = Array.from(this.pending.keys())
    for (const id of ids) {
      this.flushTerminal(id)
    }
  }

  dispose(): void {
    if (this.immediate !== null) {
      clearImmediate(this.immediate)
      this.immediate = null
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
    this.pendingBytes.clear()
    this.resyncPending.clear()
  }
}
