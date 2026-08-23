/** Id of the terminal widget currently holding keyboard focus, if any. */
let terminalFocusedId: string | null = null
/**
 * The last terminal to hold focus, which — unlike the one holding it *now* —
 * survives the user clicking away. When an agent opens a terminal, this is the
 * shell that agent is running in: the user typed the request into it and it is
 * the only end of the connection the app can actually know about.
 */
let lastFocusedTerminalId: string | null = null

const mountedTerminals = new Set<string>()

/** Read by `before-input-event` in the main window so terminal keys win over menu accelerators. */
export function focusedTerminalId(): string | null {
  return terminalFocusedId
}

/** Best guess at which terminal a newly requested widget was spawned from. */
export function originTerminalId(): string | null {
  return terminalFocusedId ?? lastFocusedTerminalId
}

/** Forgets a closed terminal so a dead id never anchors a new connection. */
export function forgetTerminalOrigin(id: string): void {
  if (terminalFocusedId === id) terminalFocusedId = null
  if (lastFocusedTerminalId === id) lastFocusedTerminalId = null
}

/** The renderer reports which widget currently holds keyboard focus. */
export function setFocusedTerminal(id: string | null): void {
  terminalFocusedId = id
  if (id) lastFocusedTerminalId = id
}

export function isTerminalMounted(id: string): boolean {
  return mountedTerminals.has(id)
}

export function clearMountedTerminals(): void {
  mountedTerminals.clear()
}

export function markTerminalMounted(id: string): void {
  mountedTerminals.add(id)
}

export function unmarkTerminalMounted(id: string): void {
  mountedTerminals.delete(id)
}
