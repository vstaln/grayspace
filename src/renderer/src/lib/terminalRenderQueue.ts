// Bound both the application queue and the data handed to xterm's parser.
export class TerminalRenderQueue {
  private pending = ''
  private busy = false
  private paused = false
  private disposed = false
  private dropped = false
  private readonly write: (data: string, done: () => void) => void
  private readonly schedule: () => void
  private readonly limit: number
  private readonly chunkSize: number

  /**
   * `chunkSize` is what one frame hands to xterm's parser, so it sets the
   * ceiling on throughput: one chunk is written per scheduled frame, the next
   * only after the parser reports the previous one done. At 32KB that ceiling
   * was ~1.9MB/s, and anything past it piled up in `pending` until the `limit`
   * evicted the oldest bytes — which shows up as holes in the output plus the
   * CAN + SGR-reset resync prefix, i.e. the scrollback loses its colour.
   *
   * 128KB per frame is ~7.7MB/s, comfortably above what an agent streaming a
   * diff produces, and still small enough that a single parse does not show up
   * as a dropped frame. The larger backlog then absorbs a burst instead of
   * discarding it; eviction stays as the last resort it was meant to be.
   */
  constructor(
    write: (data: string, done: () => void) => void,
    schedule: () => void,
    limit = 2 * 1024 * 1024,
    chunkSize = 128 * 1024
  ) {
    this.write = write
    this.schedule = schedule
    this.limit = Math.max(2, limit)
    this.chunkSize = Math.max(2, chunkSize)
  }

  get pendingLength(): number { return this.pending.length }

  push(data: string): void {
    if (this.disposed || !data) return
    this.pending += data
    if (this.pending.length > this.limit) {
      let cut = this.pending.length - this.limit
      if (isLowSurrogate(this.pending.charCodeAt(cut))) cut += 1
      this.pending = this.pending.slice(cut)
      this.dropped = true
    }
    this.schedule()
  }

  pause(paused: boolean): void {
    this.paused = paused
    if (!paused && this.pending) this.schedule()
  }

  flush(): void {
    if (this.disposed || this.paused || this.busy || !this.pending) return
    let end = Math.min(this.chunkSize, this.pending.length)
    if (end < this.pending.length && isLowSurrogate(this.pending.charCodeAt(end))) end -= 1
    const prefix = this.dropped ? '\x18\x1b[0m' : ''
    const data = prefix + this.pending.slice(0, end)
    this.pending = this.pending.slice(end)
    this.dropped = false
    this.busy = true
    try {
      this.write(data, () => {
        this.busy = false
        if (!this.disposed && this.pending) this.schedule()
      })
    } catch (error) {
      this.busy = false
      this.pending = ''
      console.warn('terminal parser write failed', error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.pending = ''
  }
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }
