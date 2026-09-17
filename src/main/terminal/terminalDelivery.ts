const INPUT_QUEUE_STALL_MS = 5_000
export const SUBMIT_BURST_GAP_MS = 120
export const SUBMIT_SETTLE_QUIET_MS = 60
export const SUBMIT_SETTLE_MAX_MS = 500

export function isDeadSessionError(error: { message?: string } | string): boolean {
  const message = (typeof error === 'string' ? error : error?.message ?? '').toLowerCase()
  return message.includes('actor stopped') || message.includes('unknown terminal')
}

export function isStalledInputError(error: { message?: string } | string): boolean {
  const message = (typeof error === 'string' ? error : error?.message ?? '').toLowerCase()
  return message.includes('is not reading input')
}

export function takeInputTurn(previous: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('terminal input queue timed out')), INPUT_QUEUE_STALL_MS)
    timer.unref?.()
    void previous.catch(() => undefined).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function normalizeDeliveryText(value: string): string {
  return String(value ?? '')
    .replace(/\x1b\][^\x07\x9c\x1b]*(?:\x07|\x9c|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The same text with every seam an agent TUI can put through it removed.
 *
 * A composer wraps what it was handed to its own width, and the wrap can fall
 * inside a word, with the frame's border glyphs sitting between the halves.
 * Once the escapes are gone that reads as "half word" + "rest of it", which
 * matched nothing — so a message that was sitting in the target's input box,
 * plainly visible, was reported back to the sender as never delivered. Joining
 * across whitespace and box-drawing glyphs makes the comparison see the text
 * the way a person looking at the screen does.
 */
export function compactDeliveryText(value: string): string {
  return value.replace(/[\s\u2500-\u257f]+/g, '')
}

export function pasteMarkerMatches(value: string, expectedLength: number): boolean {
  const marker = /\[\s*pasted\s+(?:content|text)\b([^\]\r\n]*)\]/gi
  for (const match of value.matchAll(marker)) {
    const body = match[1] ?? ''
    const explicitLength = body.match(/(\d[\d,]*)\s*(?:chars?|characters?)\b/i)?.[1]
    const candidate = explicitLength ?? [...body.matchAll(/\d[\d,]*/g)].at(-1)?.[0]
    if (candidate && Number(candidate.replace(/,/g, '')) === expectedLength) return true
  }
  return false
}

export function deliveryDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
