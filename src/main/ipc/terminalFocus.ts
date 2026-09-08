
let terminalFocusedId: string | null = null






let lastFocusedTerminalId: string | null = null

const mountedTerminals = new Set<string>()


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
