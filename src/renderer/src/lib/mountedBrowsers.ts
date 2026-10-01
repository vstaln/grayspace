/**
 * Browser views that can take an agent action right now. Canvas browsers and
 * Code browsers share one action channel, but only canvas widgets appear in
 * the canvas widget list — waiting on that list alone meant every action for a
 * browser in Code was answered "did not mount".
 */
const mounted = new Set<string>()
const codeGuests = new Set<number>()

export function markCodeBrowserGuest(id: number): () => void {
  codeGuests.add(id)
  return () => { codeGuests.delete(id) }
}

export function isCodeBrowserGuest(id: number): boolean {
  return codeGuests.has(id)
}

export function markBrowserMounted(id: string): () => void {
  mounted.add(id)
  return () => {
    mounted.delete(id)
  }
}

export function isBrowserMounted(id: string): boolean {
  return mounted.has(id)
}
