export interface RingBufferOptions {
  maxBytes?: number
}

/**
 * Scrollback for one pty.
 *
 * The naive version — `output = (output + chunk).slice(-limit)` — is O(limit)
 * per chunk: V8 flattens the cons string on every `slice`, so a 50 KB buffer
 * copies ~100 KB for each arriving chunk. An agent CLI streaming tokens emits
 * hundreds of small chunks a second, per terminal, and all of it lands on the
 * Electron main thread — which is also the thread serving every IPC call, the
 * canvas, and the window. That allocation churn (and the GC it causes) is what
 * made the whole app stutter while agent terminals were busy.
 *
 * Here an append is O(chunk): chunks are kept as a list and only whole chunks
 * are dropped off the head once the budget is exceeded. Joining is what costs
 * O(n), so the joined form is cached and only rebuilt after new data arrives.
 */
export class TerminalRingBuffer {
  private chunks: string[] = []
  /**
   * Index of the oldest chunk still live. Dropping the head advances this
   * instead of shifting the array: `shift`/`splice(0, n)` are O(remaining), and
   * at a 50 KB budget with typical 40-byte pty chunks the list holds well over
   * a thousand entries — so paying that on *every* append was most of the cost
   * this class exists to avoid. The dead prefix is discarded in one pass once
   * it grows past half the array.
   */
  private head = 0
  private totalBytes = 0
  private readonly maxBytes: number
  private headOffset = 0 // Global offset of the first byte still buffered
  /** Joined form of the live chunks, or null when a later append invalidated it. */
  private joined: string | null = ''

  constructor(options: RingBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? 512 * 1024 // 512 KB default
  }

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.totalBytes += chunk.length
    this.joined = null

    while (this.totalBytes > this.maxBytes && this.head < this.chunks.length - 1) {
      const dropped = this.chunks[this.head].length
      // Free the reference so a big chunk is not pinned by the dead prefix.
      this.chunks[this.head] = ''
      this.head += 1
      this.totalBytes -= dropped
      this.headOffset += dropped
    }

    // A single write larger than the whole budget is trimmed rather than
    // dropped — otherwise the buffer would come back empty.
    if (this.totalBytes > this.maxBytes && this.head === this.chunks.length - 1) {
      const last = this.chunks[this.head]
      const kept = last.slice(-this.maxBytes)
      this.headOffset += last.length - kept.length
      this.chunks[this.head] = kept
      this.totalBytes = kept.length
    }

    if (this.head > 32 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  get length(): number {
    return this.totalBytes
  }

  /** Byte position just past the newest byte, counted since the pty started. */
  get globalOffset(): number {
    return this.headOffset + this.totalBytes
  }

  /** Oldest byte position still retained; a reader below this has lost bytes. */
  get startOffset(): number {
    return this.headOffset
  }

  read(sinceOffset: number, maxBytes = 128 * 1024): { data: string; newOffset: number } {
    if (sinceOffset >= this.globalOffset) {
      return { data: '', newOffset: this.globalOffset }
    }

    const localStart = Math.max(0, sinceOffset - this.headOffset)
    // Skip whole chunks instead of joining the entire buffer to slice its tail:
    // an agent draining output every poll would otherwise pay for the full
    // scrollback on every read.
    let index = this.head
    let skipped = 0
    while (index < this.chunks.length && skipped + this.chunks[index].length <= localStart) {
      skipped += this.chunks[index].length
      index += 1
    }
    const want = maxBytes + (localStart - skipped)
    const parts: string[] = []
    let collected = 0
    for (; index < this.chunks.length && collected < want; index += 1) {
      parts.push(this.chunks[index])
      collected += this.chunks[index].length
    }
    const from = localStart - skipped
    const slice = parts.join('').slice(from, from + maxBytes)

    return {
      data: slice,
      newOffset: sinceOffset + slice.length
    }
  }

  toString(): string {
    if (this.joined === null) {
      this.joined = this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join('')
    }
    return this.joined
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.totalBytes = 0
    this.headOffset = 0
    this.joined = ''
  }
}
