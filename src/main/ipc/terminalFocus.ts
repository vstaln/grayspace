
let terminalFocusedId: string | null = null






let lastFocusedTerminalId: string | null = null

const mountedTerminals = new Map<string, number>()


export function focusedTerminalId(): string | null {
  return terminalFocusedId
}


export function originTerminalId(): string | null {
  return terminalFocusedId ?? lastFocusedTerminalId
}


export function forgetTerminalOrigin(id: string): void {
  if (terminalFocusedId === id) terminalFocusedId = null
  if (lastFocusedTerminalId === id) lastFocusedTerminalId = null
}


export function setFocusedTerminal(id: string | null): void {
  terminalFocusedId = id
  if (id) lastFocusedTerminalId = id
}

/**
 * Clear focus only if `id` is the terminal that actually holds it.
 *
 * A widget losing focus (or unmounting) reports `false` for its own id. Taken
 * literally that blanked the global focus even when a different terminal had
 * already taken it — so a closing widget stole the origin attribution from the
 * one the user was actually typing in.
 */
export function blurTerminal(id: string): void {
  if (terminalFocusedId === id) terminalFocusedId = null
}

export function isTerminalMounted(id: string): boolean {
  return (mountedTerminals.get(id) ?? 0) > 0
}

export function clearMountedTerminals(): void {
  mountedTerminals.clear()
}

/**
 * Mount tracking is a reference count, not a set, because two widget
 * generations for the same terminal overlap routinely: closing one widget
 * re-renders its neighbours (in the code view a 3-session layout is a
 * different subtree entirely, so every surviving terminal remounts), and the
 * new widget's `create` can be handled before the old one's `detach`.
 *
 * With a set, that interleaving deleted the mark belonging to the *live*
 * widget. Nothing crashed — `terminal:onData` was simply dropped from then on,
 * so the terminal kept accepting keystrokes and never painted a byte again,
 * which is indistinguishable from a hung shell and only closing the widget
 * cleared it. A count ends at 1 under either ordering.
 */
export function markTerminalMounted(id: string): void {
  mountedTerminals.set(id, (mountedTerminals.get(id) ?? 0) + 1)
}

export function unmarkTerminalMounted(id: string): void {
  const next = (mountedTerminals.get(id) ?? 0) - 1
  if (next > 0) mountedTerminals.set(id, next)
  else mountedTerminals.delete(id)
}

/** The terminal is gone for good (disposed), so drop every outstanding mount. */
export function forgetTerminalMounted(id: string): void {
  mountedTerminals.delete(id)
}
