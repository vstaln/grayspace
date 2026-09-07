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
  private headOffset = 0 // Global UTF-8 byte offset of the first retained string
  /** Joined form of the live chunks, or null when a later append invalidated it. */
  private joined: string | null = ''

  constructor(options: RingBufferOptions = {}) {
    this.maxBytes = options.maxBytes ?? 512 * 1024 // 512 KB default
  }

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
    this.totalBytes += Buffer.byteLength(chunk, 'utf8')
    this.joined = null

    while (this.totalBytes > this.maxBytes && this.head < this.chunks.length - 1) {
      const dropped = this.chunks[this.head]
      // Free the reference so a big chunk is not pinned by the dead prefix.
      this.chunks[this.head] = ''
      this.head += 1
      this.totalBytes -= Buffer.byteLength(dropped, 'utf8')
      this.headOffset += Buffer.byteLength(dropped, 'utf8')
    }

    // A single write larger than the whole budget is trimmed rather than
    // dropped — otherwise the buffer would come back empty.
    if (this.totalBytes > this.maxBytes && this.head === this.chunks.length - 1) {
      const last = this.chunks[this.head]
      const kept = utf8Tail(last, this.maxBytes)
      this.headOffset += Buffer.byteLength(last, 'utf8') - Buffer.byteLength(kept, 'utf8')
      this.chunks[this.head] = kept
      this.totalBytes = Buffer.byteLength(kept, 'utf8')
    }

    if (this.head > 32 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  get length(): number {
    return this.totalBytes
  }

  /** Byte offset just past the newest chunk, counted since the pty started. */
  get globalOffset(): number {
    return this.headOffset + this.totalBytes
  }

  /** Oldest byte offset still retained; a reader below this has lost bytes. */
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
    while (index < this.chunks.length && skipped + Buffer.byteLength(this.chunks[index], 'utf8') <= localStart) {
      skipped += Buffer.byteLength(this.chunks[index], 'utf8')
      index += 1
    }
    const want = maxBytes + (localStart - skipped)
    const parts: string[] = []
    let collected = 0
    for (; index < this.chunks.length && collected < want; index += 1) {
      parts.push(this.chunks[index])
      collected += Buffer.byteLength(this.chunks[index], 'utf8')
    }
    const from = localStart - skipped
    const bytes = Buffer.from(parts.join(''), 'utf8')
    let start = Math.min(from, bytes.length)
    // Never begin in the middle of a UTF-8 sequence. The skipped continuation
    // bytes still count toward the returned offset so a reader cannot repeat
    // them on its next poll.
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
    let end = Math.min(bytes.length, start + maxBytes)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
    const slice = bytes.subarray(start, end).toString('utf8')

    return {
      data: slice,
      newOffset: this.headOffset + skipped + end
    }
  }

  toString(): string {
    if (this.joined === null) {
      this.joined = this.head === 0 ? this.chunks.join('') : this.chunks.slice(this.head).join('')
    }
    return this.joined
  }

  /**
   * Last `maxBytes` of the buffer as a string, without ever joining the full
   * scrollback. Iterates chunks from the tail and stops once the budget is
   * full — the hot path for "what is in the terminal right now" from agents.
   * Returns '' for a 0 / negative limit.
   */
  tail(maxBytes: number): string {
    if (maxBytes <= 0 || this.totalBytes === 0) return ''
    const budget = Math.min(maxBytes, this.totalBytes)
    const parts: string[] = []
    let collected = 0
    for (let i = this.chunks.length - 1; i >= this.head && collected < budget; i -= 1) {
      const chunk = this.chunks[i]
      const size = Buffer.byteLength(chunk, 'utf8')
      if (collected + size <= budget) {
        parts.unshift(chunk)
        collected += size
        continue
      }
      const need = budget - collected
      let slice = Buffer.from(chunk, 'utf8')
      let start = Math.max(0, slice.length - need)
      while (start < slice.length && (slice[start] & 0xc0) === 0x80) start += 1
      parts.unshift(slice.subarray(start).toString('utf8'))
      collected = budget
      break
    }
    return parts.join('')
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.totalBytes = 0
    this.headOffset = 0
    this.joined = ''
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const bytes = Buffer.from(value, 'utf8')
  let out = bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString('utf8')
  // A byte slice can start inside a code point. Drop the replacement marker
  // rather than retaining malformed text in the terminal scrollback.
  while (out.startsWith('\uFFFD')) out = out.slice(1)
  return out
}
