






const pending = new Map<string, string>()

export function queueInitialCommand(id: string, command: string): void {
  pending.set(id, command)
}


export function takeInitialCommand(id: string): string | undefined {
  const command = pending.get(id)
  if (command !== undefined) pending.delete(id)
  return command
}

export function clearInitialCommand(id: string): void {
  pending.delete(id)
}
